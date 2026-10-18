"""Content-addressed artifact catalog + aliases + webhooks (folder-native).

Layout under ``artifacts/catalog/``::

  entries/<hex>.json   # one record per id
  index.jsonl          # append-only listing
  aliases.json         # name → id (+ meta)
  events.jsonl         # create / alias / promote audit (+ webhook results)

Recipe (optional)::

  artifacts:
    webhooks:
      - on: [create, alias, promote]
        url: https://example.com/hook
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.paths import art_dir, peek_recipe
from protocol.recipe import load_recipe


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hex(aid: str) -> str:
    s = aid.strip()
    if s.startswith("sha256:"):
        s = s[7:]
    return s


def catalog_dir(train: Path) -> Path:
    d = art_dir(train) / "catalog"
    d.mkdir(parents=True, exist_ok=True)
    (d / "entries").mkdir(parents=True, exist_ok=True)
    return d


def _entry_path(train: Path, aid: str) -> Path:
    return catalog_dir(train) / "entries" / f"{_hex(aid)}.json"


def _aliases_path(train: Path) -> Path:
    return catalog_dir(train) / "aliases.json"


def _index_path(train: Path) -> Path:
    return catalog_dir(train) / "index.jsonl"


def _events_path(train: Path) -> Path:
    return catalog_dir(train) / "events.jsonl"


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, default=str) + "\n")


def _norm_id(aid: str | None) -> str | None:
    if not aid or not isinstance(aid, str):
        return None
    s = aid.strip()
    if not s:
        return None
    if s.startswith("sha256:"):
        return s
    if len(s) >= 16 and all(c in "0123456789abcdef" for c in s.lower()):
        return "sha256:" + s
    return s


def get(train: Path, aid: str) -> dict[str, Any] | None:
    """Load one catalog entry by id (full or hex prefix)."""
    want = _norm_id(aid) or aid
    direct = _entry_path(train, want)
    body = _read_json(direct)
    if body is not None:
        return body
    # prefix match
    bare = _hex(want)
    entries = catalog_dir(train) / "entries"
    if not entries.is_dir():
        return None
    hits = sorted(p for p in entries.glob("*.json") if p.stem.startswith(bare) or bare in p.stem)
    if len(hits) == 1:
        return _read_json(hits[0])
    return None


def list_entries(
    train: Path,
    *,
    kind: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """List catalog entries (newest first)."""
    entries = catalog_dir(train) / "entries"
    if not entries.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for p in entries.glob("*.json"):
        body = _read_json(p)
        if body is None:
            continue
        if kind and str(body.get("kind") or "") != kind:
            continue
        rows.append(body)
    rows.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
    if limit is not None:
        rows = rows[: max(0, limit)]
    return rows


def register(
    train: Path,
    *,
    aid: str,
    kind: str,
    path: str | None = None,
    parents: list[str] | None = None,
    meta: dict[str, Any] | None = None,
    event: str = "create",
    quiet: bool = False,
) -> dict[str, Any]:
    """Upsert a content-addressed artifact and emit a create event (+ webhooks)."""
    mid = _norm_id(aid)
    if not mid:
        raise ValueError("artifact id required")
    existing = get(train, mid)
    parents_n = []
    for p in parents or []:
        np = _norm_id(p)
        if np and np not in parents_n:
            parents_n.append(np)
    if existing:
        # merge parents / meta; keep earliest at
        merged_parents = list(existing.get("parents") or [])
        for p in parents_n:
            if p not in merged_parents:
                merged_parents.append(p)
        body = {
            **existing,
            "kind": kind or existing.get("kind"),
            "path": path or existing.get("path"),
            "parents": merged_parents,
            "meta": {**(existing.get("meta") or {}), **(meta or {})},
            "updated_at": _now(),
        }
        created = False
    else:
        body = {
            "id": mid,
            "kind": kind,
            "at": _now(),
            "path": path,
            "parents": parents_n,
            "meta": dict(meta or {}),
        }
        created = True
    ep = _entry_path(train, mid)
    ep.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    if created:
        _append_jsonl(
            _index_path(train),
            {"id": mid, "kind": kind, "at": body["at"], "path": path},
        )
        if not quiet:
            _emit(train, event="create", artifact=body)
    return body


def load_aliases(train: Path) -> dict[str, Any]:
    raw = _read_json(_aliases_path(train)) or {}
    # normalize values to {id, at, kind?}
    out: dict[str, Any] = {}
    for name, val in raw.items():
        if isinstance(val, str):
            out[name] = {"id": _norm_id(val) or val, "at": None}
        elif isinstance(val, dict) and val.get("id"):
            out[name] = {
                "id": _norm_id(str(val["id"])) or str(val["id"]),
                "at": val.get("at"),
                "kind": val.get("kind"),
                "by": val.get("by"),
            }
    return out


def resolve_alias(train: Path, name: str) -> dict[str, Any] | None:
    """Resolve alias name → catalog entry (or None)."""
    key = name.strip().lstrip("@")
    if not key:
        return None
    aliases = load_aliases(train)
    ptr = aliases.get(key)
    if not ptr:
        return None
    return get(train, str(ptr["id"]))


def set_alias(
    train: Path,
    name: str,
    aid: str,
    *,
    kind: str | None = None,
    by: str = "alias",
    event: str | None = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Point ``name`` at artifact ``aid`` (mutable promotion pointer)."""
    key = name.strip().lstrip("@")
    if not key:
        raise ValueError("alias name required")
    mid = _norm_id(aid)
    if not mid:
        raise ValueError("artifact id required")
    entry = get(train, mid)
    if entry is None:
        # allow aliasing an id that will be registered next; still record pointer
        entry = {"id": mid, "kind": kind or "model"}
    aliases = load_aliases(train)
    prev = aliases.get(key)
    ptr = {
        "id": mid,
        "at": _now(),
        "kind": kind or entry.get("kind"),
        "by": by,
    }
    aliases[key] = ptr
    _aliases_path(train).write_text(json.dumps(aliases, indent=2) + "\n", encoding="utf-8")
    # skip no-op / quiet rebuilds
    if not quiet and (not prev or prev.get("id") != mid or by == "promote"):
        ev = event or ("promote" if by == "promote" else "alias")
        _emit(
            train,
            event=ev,
            artifact=entry if isinstance(entry, dict) else {"id": mid},
            alias=key,
            pointer=ptr,
        )
    return {"name": key, **ptr}


def promote(
    train: Path,
    name: str = "prod",
    ref: str = "last",
    *,
    require_pass: bool | None = None,
) -> dict[str, Any]:
    """CI/CD handoff: resolve ref → model artifact, set alias, fire promote webhooks."""
    entry = resolve_ref(train, ref)
    if entry is None:
        raise FileNotFoundError(f"no artifact for {ref!r}")
    if entry.get("kind") and entry["kind"] != "model":
        # allow promoting any kind, but default path is model
        pass
    if require_pass is None:
        require_pass = bool((_artifacts_cfg(train).get("promote") or {}).get("require_pass"))
    if require_pass:
        run_id = (entry.get("meta") or {}).get("run_id")
        if run_id:
            run = _read_json(art_dir(train) / "runs" / f"{run_id}.json")
            if run is not None and run.get("pass") is False:
                raise SystemExit(f"refuse promote {name!r}: run {run_id} failed gate")
    return set_alias(
        train,
        name,
        str(entry["id"]),
        kind=str(entry.get("kind") or "model"),
        by="promote",
        event="promote",
    )


def resolve_ref(train: Path, ref: str = "last") -> dict[str, Any] | None:
    """Resolve last / alias / id / checkpoint-ish ref to a catalog entry."""
    raw = (ref or "last").strip()
    if raw in ("", "last", "latest"):
        # prefer alias latest, else newest model entry
        hit = resolve_alias(train, "latest")
        if hit:
            return hit
        models = list_entries(train, kind="model", limit=1)
        return models[0] if models else None
    if raw.startswith("@"):
        return resolve_alias(train, raw)
    # bare alias name?
    hit = resolve_alias(train, raw)
    if hit:
        return hit
    return get(train, raw)


def _artifacts_cfg(train: Path) -> dict[str, Any]:
    try:
        rec = peek_recipe(train) or load_recipe(train)
    except Exception:
        rec = {}
    block = rec.get("artifacts") if isinstance(rec, dict) else None
    cfg = dict(block) if isinstance(block, dict) else {}
    # optional local override file
    local = _read_json(catalog_dir(train) / "webhooks.json")
    if local and isinstance(local.get("webhooks"), list):
        cfg["webhooks"] = local["webhooks"]
    rel = train / "artifacts" / "webhooks.json"
    # also allow artifacts/webhooks.json beside catalog
    alt = _read_json(art_dir(train) / "webhooks.json")
    if alt and isinstance(alt.get("webhooks"), list):
        cfg["webhooks"] = alt["webhooks"]
    _ = rel  # reserved
    return cfg


def _webhook_targets(train: Path, event: str) -> list[dict[str, Any]]:
    hooks = _artifacts_cfg(train).get("webhooks") or []
    if not isinstance(hooks, list):
        return []
    out: list[dict[str, Any]] = []
    for h in hooks:
        if not isinstance(h, dict):
            continue
        on = h.get("on") or ["create", "alias", "promote"]
        if isinstance(on, str):
            on = [on]
        if event not in on:
            continue
        url = h.get("url")
        if not url:
            continue
        out.append(h)
    return out


def _emit(
    train: Path,
    *,
    event: str,
    artifact: dict[str, Any],
    alias: str | None = None,
    pointer: dict[str, Any] | None = None,
) -> None:
    payload = {
        "event": event,
        "at": _now(),
        "train": str(train.resolve()),
        "artifact": {
            "id": artifact.get("id"),
            "kind": artifact.get("kind"),
            "path": artifact.get("path"),
            "parents": artifact.get("parents"),
            "meta": artifact.get("meta"),
        },
        "alias": alias,
        "pointer": pointer,
    }
    # attach lineage snapshot when we can
    try:
        from protocol.lineage import resolve_lineage

        ref = artifact.get("id") or artifact.get("path") or "last"
        payload["lineage"] = resolve_lineage(train, str(ref))
    except Exception:
        payload["lineage"] = None

    results = []
    for h in _webhook_targets(train, event):
        url = str(h["url"])
        ok, detail = _post_webhook(url, payload, headers=h.get("headers") if isinstance(h.get("headers"), dict) else None)
        results.append({"url": url, "ok": ok, "detail": detail})
    row = {**payload, "webhooks": results}
    _append_jsonl(_events_path(train), row)


def _post_webhook(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
) -> tuple[bool, str]:
    body = json.dumps(payload, default=str).encode("utf-8")
    req_headers = {"Content-Type": "application/json", "User-Agent": "aq-artifacts/1"}
    if headers:
        req_headers.update({str(k): str(v) for k, v in headers.items()})
    req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return True, f"HTTP {getattr(resp, 'status', 200)}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:200]


def sync_from_run(
    train: Path,
    run: dict[str, Any],
    *,
    quiet: bool = False,
) -> list[dict[str, Any]]:
    """Register data / code / run / model nodes + edges from a run record; set ``latest``."""
    registered: list[dict[str, Any]] = []
    rid = str(run.get("id") or "")
    parents_for_model: list[str] = []

    data = run.get("data") if isinstance(run.get("data"), dict) else None
    dh = (data or {}).get("hash") or run.get("data_hash")
    if dh:
        e = register(
            train,
            aid=str(dh),
            kind="data",
            path=(data or {}).get("path"),
            meta={
                "n": (data or {}).get("n"),
                "columns": (data or {}).get("columns"),
                "target": (data or {}).get("target"),
                "run_id": rid or None,
            },
            quiet=quiet,
        )
        registered.append(e)
        parents_for_model.append(str(e["id"]))

    code = run.get("code") if isinstance(run.get("code"), dict) else None
    ch = run.get("code_hash")
    if ch:
        e = register(
            train,
            aid=str(ch),
            kind="code",
            path=(code or {}).get("tree"),
            parents=[parents_for_model[0]] if parents_for_model else None,
            meta={"run_id": rid or None, "manifest": (code or {}).get("manifest")},
            quiet=quiet,
        )
        registered.append(e)
        parents_for_model.append(str(e["id"]))

    # run node: hash of run id + recipe_hash
    if rid:
        import hashlib

        h = hashlib.sha256()
        h.update(rid.encode())
        h.update(str(run.get("recipe_hash") or "").encode())
        run_aid = "sha256:" + h.hexdigest()
        e = register(
            train,
            aid=run_aid,
            kind="run",
            path=f"artifacts/runs/{rid}.json",
            parents=list(parents_for_model),
            meta={
                "run_id": rid,
                "recipe_hash": run.get("recipe_hash"),
                "pass": run.get("pass"),
                "at": run.get("at"),
            },
            quiet=quiet,
        )
        registered.append(e)
        parents_for_model.append(str(e["id"]))

    model = run.get("model") if isinstance(run.get("model"), dict) else None
    mid = (model or {}).get("id") or (run.get("artifacts") or {}).get("logged_model")
    if mid:
        ckpt = (model or {}).get("checkpoint") or (run.get("artifacts") or {}).get("checkpoint")
        e = register(
            train,
            aid=str(mid),
            kind="model",
            path=ckpt,
            parents=list(parents_for_model),
            meta={
                "run_id": rid or None,
                "data_hash": (model or {}).get("data_hash") or run.get("data_hash"),
                "method": (run.get("recipe") or {}).get("method")
                if isinstance(run.get("recipe"), dict)
                else None,
            },
            quiet=quiet,
        )
        registered.append(e)
        set_alias(train, "latest", str(e["id"]), kind="model", by="train", quiet=quiet)
        if run.get("pass") is True:
            set_alias(train, "best", str(e["id"]), kind="model", by="train", quiet=quiet)

    return registered


def rebuild(train: Path) -> dict[str, int]:
    """Index all run records into the catalog (idempotent, quiet)."""
    runs = art_dir(train) / "runs"
    n_runs = 0
    n_arts = 0
    if runs.is_dir():
        for p in sorted(runs.glob("*.json")):
            if p.name == "last.json":
                continue
            body = _read_json(p)
            if not body:
                continue
            n_runs += 1
            n_arts += len(sync_from_run(train, body, quiet=True))
    rev = _read_json(train / "data" / "revision.json")
    if rev and rev.get("hash"):
        register(
            train,
            aid=str(rev["hash"]),
            kind="data",
            path=rev.get("path"),
            meta={"n": rev.get("n"), "columns": rev.get("columns"), "target": rev.get("target")},
            quiet=True,
        )
        n_arts += 1
    return {"runs": n_runs, "artifacts": n_arts}
