"""Persist Flow step attributes under ``artifacts/flow/<name>/<run_id>/``.

Blobs are content-addressed under ``cas/`` (sha256) for dedupe + integrity.
Named files under ``artifacts/`` are small pointers (or legacy raw JSON/pkl).
"""

from __future__ import annotations

import hashlib
import json
import pickle
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_name(name: str) -> str:
    out = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    return out or "x"


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _hex(aid: str) -> str:
    s = aid.strip()
    if s.startswith("sha256:"):
        s = s[7:]
    return s


class ArtifactStore:
    """Named artifacts backed by a content-addressed ``cas/`` store."""

    def __init__(self, root: Path, *, cas: Path | None = None):
        self.root = root
        self.dir = root / "artifacts"
        # shared CAS for attempt dirs under the same run
        self.cas = cas if cas is not None else (root / "cas")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cas.mkdir(parents=True, exist_ok=True)

    def _cas_path(self, aid: str) -> Path:
        h = _hex(aid)
        # shard: ab/cd/<rest> for lighter dirs
        return self.cas / h[:2] / h[2:4] / h

    def _write_cas(self, data: bytes) -> str:
        aid = _sha256_bytes(data)
        path = self._cas_path(aid)
        if path.is_file():
            # dedupe — already stored
            return aid
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return aid

    def _read_cas(self, aid: str) -> bytes:
        path = self._cas_path(aid)
        if not path.is_file():
            raise FileNotFoundError(f"missing cas blob {aid}")
        return path.read_bytes()

    def put(self, name: str, value: Any, *, origin_pathspec: str | None = None) -> Path:
        """Store ``value`` by content hash; name points at the sha."""
        key = _safe_name(name)
        fmt = "json"
        try:
            data = (json.dumps(value, indent=2) + "\n").encode("utf-8")
        except TypeError:
            fmt = "pkl"
            data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)

        aid = self._write_cas(data)
        pointer: dict[str, Any] = {"aq_cas": aid, "format": fmt, "at": _now()}
        if origin_pathspec:
            pointer["origin_pathspec"] = origin_pathspec
        # clear legacy raw siblings
        for suffix in (".json", ".pkl"):
            legacy = self.dir / f"{key}{suffix}"
            # only remove if it's not our pointer file we'll overwrite
            if suffix == ".pkl" and legacy.is_file():
                legacy.unlink()
            if suffix == ".json" and legacy.is_file():
                try:
                    old = json.loads(legacy.read_text(encoding="utf-8"))
                    if not (isinstance(old, dict) and "aq_cas" in old):
                        pass  # overwrite below
                except Exception:
                    pass
        ptr_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"
        if pkl_path.is_file():
            pkl_path.unlink()
        ptr_path.write_text(json.dumps(pointer, indent=2) + "\n", encoding="utf-8")
        self._update_index(key, aid, fmt, origin_pathspec=origin_pathspec)
        return ptr_path

    def _update_index(
        self,
        name: str,
        aid: str,
        fmt: str,
        *,
        origin_pathspec: str | None = None,
    ) -> None:
        idx_path = self.root / "cas_index.json"
        idx: dict[str, Any] = {}
        if idx_path.is_file():
            try:
                raw = json.loads(idx_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    idx = raw
            except json.JSONDecodeError:
                idx = {}
        ent: dict[str, Any] = {"id": aid, "format": fmt, "at": _now()}
        if origin_pathspec:
            ent["origin_pathspec"] = origin_pathspec
        idx[name] = ent
        idx_path.write_text(json.dumps(idx, indent=2) + "\n", encoding="utf-8")

    def id_of(self, name: str) -> str | None:
        """Content id for a named artifact, if known."""
        key = _safe_name(name)
        ptr = self.dir / f"{key}.json"
        if ptr.is_file():
            try:
                body = json.loads(ptr.read_text(encoding="utf-8"))
                if isinstance(body, dict) and body.get("aq_cas"):
                    return str(body["aq_cas"])
            except json.JSONDecodeError:
                pass
        idx_path = self.root / "cas_index.json"
        if idx_path.is_file():
            try:
                idx = json.loads(idx_path.read_text(encoding="utf-8"))
                ent = idx.get(key) if isinstance(idx, dict) else None
                if isinstance(ent, dict) and ent.get("id"):
                    return str(ent["id"])
            except json.JSONDecodeError:
                pass
        return None

    def ids(self) -> dict[str, str]:
        """name → sha256 id."""
        out: dict[str, str] = {}
        for k in self.keys():
            aid = self.id_of(k)
            if aid:
                out[k] = aid
        return out

    def get(self, name: str) -> Any:
        key = _safe_name(name)
        json_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"

        if json_path.is_file():
            try:
                body = json.loads(json_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict) and body.get("aq_cas"):
                raw = self._read_cas(str(body["aq_cas"]))
                fmt = str(body.get("format") or "json")
                if fmt == "pkl":
                    return pickle.loads(raw)
                return json.loads(raw.decode("utf-8"))
            # legacy: raw JSON value
            if body is not None:
                return body

        if pkl_path.is_file():
            with pkl_path.open("rb") as f:
                return pickle.load(f)
        raise KeyError(name)

    def load_all(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k in self.keys():
            try:
                out[k] = self.get(k)
            except Exception:
                continue
        return out

    def keys(self) -> list[str]:
        if not self.dir.is_dir():
            return []
        names: set[str] = set()
        for p in self.dir.iterdir():
            if p.suffix in (".json", ".pkl"):
                names.add(p.stem)
        return sorted(names)

    def verify(self) -> dict[str, Any]:
        """Re-hash every CAS blob + check pointers. Returns report."""
        ok: list[str] = []
        bad: list[dict[str, str]] = []
        missing: list[str] = []

        # verify all cas files
        if self.cas.is_dir():
            for p in self.cas.rglob("*"):
                if not p.is_file() or p.suffix == ".tmp":
                    continue
                data = p.read_bytes()
                got = _sha256_bytes(data)
                expect = "sha256:" + p.name
                if got != expect:
                    bad.append({"path": str(p.relative_to(self.root)), "expected": expect, "got": got})
                else:
                    ok.append(got)

        # verify named pointers resolve
        for name in self.keys():
            aid = self.id_of(name)
            if not aid:
                # legacy raw file — hash it for reporting
                continue
            path = self._cas_path(aid)
            if not path.is_file():
                missing.append(f"{name} → {aid}")
                continue
            data = path.read_bytes()
            got = _sha256_bytes(data)
            if got != aid:
                bad.append({"name": name, "expected": aid, "got": got})

        return {
            "ok": len(ok),
            "bad": bad,
            "missing": missing,
            "ids": self.ids(),
            "pass": not bad and not missing,
        }


def flow_base(train: Path, flow_name: str) -> Path:
    return train / "artifacts" / "flow" / _safe_name(flow_name)


def flow_run_dir(train: Path, flow_name: str, run_id: str | None = None) -> tuple[Path, str]:
    """``artifacts/flow/<FlowName>/<run_id>/`` (+ ``latest`` pointer)."""
    base = flow_base(train, flow_name)
    base.mkdir(parents=True, exist_ok=True)
    if run_id:
        rid = run_id
        root = base / rid
        root.mkdir(parents=True, exist_ok=True)
    else:
        # second precision + suffix if same-second collide (resume clone)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        rid = stamp
        root = base / rid
        n = 1
        while root.exists():
            rid = f"{stamp}_{n}"
            root = base / rid
            n += 1
            if n > 999:
                raise RuntimeError(f"could not allocate unique run_id under {base}")
        root.mkdir(parents=True, exist_ok=True)
    (base / "latest").write_text(rid + "\n", encoding="utf-8")
    return root, rid


def latest_run_id(train: Path, flow_name: str) -> str | None:
    p = flow_base(train, flow_name) / "latest"
    if not p.is_file():
        return None
    rid = p.read_text(encoding="utf-8").strip()
    return rid or None


def list_flow_run_ids(train: Path, flow_name: str) -> list[str]:
    """Run ids under ``artifacts/flow/<Flow>/`` (newest name-sort last)."""
    base = flow_base(train, flow_name)
    if not base.is_dir():
        return []
    out: list[str] = []
    for p in base.iterdir():
        if p.is_dir() and p.name != "latest":
            out.append(p.name)
    return sorted(out)


def _run_status(run_root: Path) -> str | None:
    st = read_steps(run_root)
    if not st:
        return None
    return str(st.get("status") or "") or None


def latest_successful_run_id(train: Path, flow_name: str) -> str | None:
    """Prefer ``latest`` if that run is ``ok``; else newest successful run."""
    base = flow_base(train, flow_name)
    rid = latest_run_id(train, flow_name)
    if rid:
        root = base / rid
        if root.is_dir() and _run_status(root) == "ok":
            return rid
    for cand in reversed(list_flow_run_ids(train, flow_name)):
        if _run_status(base / cand) == "ok":
            return cand
    return rid  # fall back to latest pointer even if incomplete


def parse_flow_ref(ref: str) -> tuple[str, str | None, str | None]:
    """Parse ``Flow``, ``Flow/run_id``, or ``Flow/run_id#artifact`` → (flow, run, artifact)."""
    p = parse_pathspec(ref)
    return p["flow"], p["run"], p["artifact"]


def parse_pathspec(ref: str) -> dict[str, Any]:
    """Parse a universal flow address into parts.

    Forms::

        Prep
        Prep/<run_id>
        Prep/latest | Prep/latest_ok
        Prep/<run>/heavy
        Prep/<run>/heavy/try_0
        Prep/<run>#rows
        Prep/<run>/heavy#rows
        Prep/<run>/heavy/try_0#partial
    """
    artifact: str | None = None
    body = ref.strip()
    if not body:
        raise ValueError("empty pathspec")
    if "#" in body:
        body, _, art = body.partition("#")
        artifact = art or None
    parts = [p for p in body.split("/") if p]
    if not parts:
        raise ValueError(f"empty pathspec: {ref!r}")
    flow = parts[0]
    run = parts[1] if len(parts) > 1 else None
    step: str | None = None
    try_n: int | None = None
    if len(parts) > 2:
        step = parts[2]
    if len(parts) > 3:
        tok = parts[3]
        if tok.startswith("try_") and tok[4:].isdigit():
            try_n = int(tok[4:])
        else:
            raise ValueError(f"expected try_N after step in pathspec, got {tok!r}")
    if len(parts) > 4:
        raise ValueError(f"pathspec too long: {ref!r}")
    if try_n is not None and step is None:
        raise ValueError(f"try_N requires a step in pathspec: {ref!r}")
    return {
        "flow": flow,
        "run": run,
        "step": step,
        "try_n": try_n,
        "artifact": artifact,
        "raw": ref.strip(),
    }


def resolve_flow_run(
    train: Path,
    flow: str,
    run: str | None = None,
    *,
    successful: bool = True,
) -> tuple[Path, str, str]:
    """Resolve ``(run_root, run_id, flow_name)`` for a flow under ``train``.

    ``flow`` may be ``Prep``, ``Prep/<run_id>``, or ``Prep/<run_id>#artifact``.
    """
    flow_name, embedded_run, _ = parse_flow_ref(flow)
    rid = run or embedded_run
    if rid is None:
        rid = (
            latest_successful_run_id(train, flow_name)
            if successful
            else latest_run_id(train, flow_name)
        )
    if not rid:
        raise FileNotFoundError(f"no runs for flow {flow_name!r} under {train}")
    root = flow_base(train, flow_name) / rid
    if not root.is_dir():
        raise FileNotFoundError(f"no flow run dir: {root}")
    return root, rid, flow_name


def open_flow_artifacts(
    train: str | Path,
    flow: str,
    *,
    run: str | None = None,
    successful: bool = True,
) -> "FlowArtifacts":
    """Open another flow run's artifacts (read-only)."""
    root_train = Path(train).expanduser().resolve()
    run_root, rid, flow_name = resolve_flow_run(
        root_train, flow, run=run, successful=successful
    )
    return FlowArtifacts(run_root, flow=flow_name, run_id=rid)


def record_import(run_root: Path, entry: dict[str, Any]) -> None:
    """Append one cross-flow import to ``imports.jsonl``."""
    path = run_root / "imports.jsonl"
    line = json.dumps({**entry, "at": _now()}, ensure_ascii=False)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


class FlowArtifacts:
    """Read-only view of another flow run's artifacts."""

    def __init__(self, root: Path, *, flow: str, run_id: str):
        self.root = root
        self.flow = flow
        self.run_id = run_id
        self._store = ArtifactStore(root)

    @property
    def pathspec(self) -> str:
        return pathspec(self.flow, self.run_id)

    def keys(self) -> list[str]:
        return self._store.keys()

    def get(self, name: str) -> Any:
        return self._store.get(name)

    def __getitem__(self, name: str) -> Any:
        return self.get(name)

    def __contains__(self, name: str) -> bool:
        return name in self._store.keys()

    def load(self) -> dict[str, Any]:
        return self._store.load_all()

    def ids(self) -> dict[str, str]:
        return self._store.ids()

    def origin_of(self, name: str) -> str:
        return pathspec(self.flow, self.run_id, artifact=name)


def write_step_meta(root: Path, step: str, **extra: Any) -> None:
    d = root / "steps"
    d.mkdir(parents=True, exist_ok=True)
    body = {"step": step, "at": _now(), **extra}
    (d / f"{_safe_name(step)}.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")


def mark_step_done(root: Path, step: str) -> None:
    d = root / "done"
    d.mkdir(parents=True, exist_ok=True)
    (d / _safe_name(step)).write_text(_now() + "\n", encoding="utf-8")


def done_steps(root: Path) -> list[str]:
    d = root / "done"
    if not d.is_dir():
        return []
    return sorted(p.name for p in d.iterdir() if p.is_file())


def is_step_done(root: Path, step: str) -> bool:
    return (root / "done" / _safe_name(step)).is_file()


def write_steps(
    root: Path,
    *,
    status: str,
    step: str | None = None,
    next_step: str | None = None,
    done: list[str] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """Flow ``steps.json`` — which step finished, what’s next, resume status."""
    body: dict[str, Any] = {
        "status": status,
        "at": _now(),
        "step": step,
        "next": next_step,
        "done": done if done is not None else done_steps(root),
    }
    if error:
        body["error"] = error
    (root / "steps.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return body


def read_steps(root: Path) -> dict[str, Any] | None:
    # prefer steps.json; accept earlier names
    for name in ("steps.json", "checkpoint.json", "cursor.json"):
        p = root / name
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return None


def write_boundary_snapshot(
    root: Path,
    *,
    step: str,
    index: int,
    next_step: str | None,
    artifacts: list[str],
    place: str | None = None,
    status: str = "ok",
    artifact_ids: dict[str, str] | None = None,
    **extra: Any,
) -> Path:
    """Freeze observability state at a step boundary (after the step finishes)."""
    snap_dir = root / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    body: dict[str, Any] = {
        "index": index,
        "step": step,
        "next": next_step,
        "status": status,
        "at": _now(),
        "place": place,
        "artifacts": list(artifacts),
        "done": done_steps(root),
    }
    if artifact_ids:
        body["artifact_ids"] = artifact_ids
    for k, v in extra.items():
        if v is not None:
            body[k] = v
    path = snap_dir / f"{index:04d}-{_safe_name(step)}.json"
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    (snap_dir / "latest.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return path


def resume_entry(root: Path) -> tuple[str | None, list[str]]:
    """Return ``(next_step_to_run, already_done)`` from ``steps.json`` / done markers."""
    done = done_steps(root)
    st = read_steps(root)
    if st:
        status = str(st.get("status") or "")
        if status == "ok" and not st.get("next"):
            return None, done  # finished
        nxt = st.get("next")
        if status in ("failed", "running") and st.get("step") and not is_step_done(root, str(st["step"])):
            return str(st["step"]), [d for d in done if d != st["step"]]
        if nxt:
            return str(nxt), done
    nxt_path = root / "next.json"
    if nxt_path.is_file():
        try:
            data = json.loads(nxt_path.read_text(encoding="utf-8"))
            n = data.get("next")
            if n:
                return str(n), done
        except json.JSONDecodeError:
            pass
    if done:
        return None, done
    return "start", []


def pathspec(flow: str, run_id: str, step: str | None = None, *, artifact: str | None = None) -> str:
    """Stable address: ``FlowName/run_id`` or ``FlowName/run_id/step`` (+ optional ``#artifact``)."""
    base = f"{_safe_name(flow)}/{run_id}"
    if step:
        base = f"{base}/{_safe_name(step)}"
    if artifact:
        base = f"{base}#{_safe_name(artifact)}"
    return base


def write_origin(
    root: Path,
    *,
    origin_pathspec: str,
    source_run: str,
    resume_step: str | None,
    cloned: bool,
) -> dict[str, Any]:
    """Record where this run (or its objects) were cloned/resumed from."""
    body = {
        "origin_pathspec": origin_pathspec,
        "source_run": source_run,
        "resume_step": resume_step,
        "cloned": cloned,
        "at": _now(),
    }
    (root / "origin_pathspec.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return body


def read_origin(root: Path) -> dict[str, Any] | None:
    p = root / "origin_pathspec.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


# --- flow-run tags (user mutable / system protected) ---

_SYSTEM_TAG_PREFIX = "sys:"


def _norm_tag(tag: str) -> str:
    t = str(tag).strip()
    if not t:
        raise ValueError("empty tag")
    return t


def _is_system_tag(tag: str) -> bool:
    return _norm_tag(tag).startswith(_SYSTEM_TAG_PREFIX)


def read_run_tags(root: Path) -> dict[str, list[str]]:
    """``{"user": [...], "system": [...]}`` from ``tags.json``."""
    p = root / "tags.json"
    empty: dict[str, list[str]] = {"user": [], "system": []}
    if not p.is_file():
        return empty
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return empty
    if not isinstance(data, dict):
        return empty
    user = [str(x) for x in (data.get("user") or []) if str(x).strip()]
    system = [str(x) for x in (data.get("system") or []) if str(x).strip()]
    return {"user": sorted(set(user)), "system": sorted(set(system))}


def all_run_tags(root: Path) -> list[str]:
    t = read_run_tags(root)
    return sorted(set(t["user"]) | set(t["system"]))


def write_run_tags(root: Path, *, user: list[str] | None = None, system: list[str] | None = None) -> dict[str, list[str]]:
    cur = read_run_tags(root)
    if user is not None:
        cur["user"] = sorted({_norm_tag(t) for t in user if not _is_system_tag(t)})
    if system is not None:
        cur["system"] = sorted({_norm_tag(t) for t in system if _is_system_tag(t)})
    root.mkdir(parents=True, exist_ok=True)
    (root / "tags.json").write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
    return cur


def add_run_tags(root: Path, *tags: str, system: bool = False) -> dict[str, list[str]]:
    """Add tags. ``system=True`` writes ``sys:…`` tags (protected)."""
    cur = read_run_tags(root)
    for raw in tags:
        t = _norm_tag(raw)
        if system:
            if not _is_system_tag(t):
                t = _SYSTEM_TAG_PREFIX + t
            cur["system"] = sorted(set(cur["system"]) | {t})
        else:
            if _is_system_tag(t):
                raise ValueError(f"cannot add system tag via user API: {t} (use system=True)")
            cur["user"] = sorted(set(cur["user"]) | {t})
    return write_run_tags(root, user=cur["user"], system=cur["system"])


def remove_run_tags(root: Path, *tags: str) -> dict[str, list[str]]:
    """Remove **user** tags only. System tags are protected."""
    cur = read_run_tags(root)
    drop = {_norm_tag(t) for t in tags}
    sys_hit = [t for t in drop if _is_system_tag(t) or t in cur["system"]]
    if sys_hit:
        raise ValueError(f"cannot remove system tags: {sorted(sys_hit)}")
    cur["user"] = sorted(set(cur["user"]) - drop)
    return write_run_tags(root, user=cur["user"], system=cur["system"])


def replace_run_tags(root: Path, *tags: str) -> dict[str, list[str]]:
    """Replace all **user** tags (system tags untouched)."""
    user = [_norm_tag(t) for t in tags]
    if any(_is_system_tag(t) for t in user):
        raise ValueError("replace_run_tags only accepts user tags (not sys:…)")
    cur = read_run_tags(root)
    return write_run_tags(root, user=user, system=cur["system"])


def set_system_tag(root: Path, key: str, value: str) -> dict[str, list[str]]:
    """Set ``sys:<key>=<value>``, replacing any prior ``sys:<key>=…``."""
    key = str(key).strip()
    if not key:
        raise ValueError("empty system tag key")
    prefix = f"{_SYSTEM_TAG_PREFIX}{key}="
    cur = read_run_tags(root)
    system = [t for t in cur["system"] if not t.startswith(prefix)]
    system.append(f"{prefix}{value}")
    return write_run_tags(root, user=cur["user"], system=system)


def tags_match(root: Path, required: str | list[str] | tuple[str, ...] | None) -> bool:
    """True if run has **all** required tags (AND). ``None`` / empty → True."""
    if required is None:
        return True
    if isinstance(required, str):
        need = [required] if required.strip() else []
    else:
        need = [str(t) for t in required if str(t).strip()]
    if not need:
        return True
    have = set(all_run_tags(root))
    return all(_norm_tag(t) in have for t in need)


def clone_run_for_resume(
    src: Path,
    dest: Path,
    *,
    flow: str,
    source_run_id: str,
    resume_step: str | None,
) -> dict[str, Any]:
    """Copy successful step state into a new run dir; stamp ``origin_pathspec`` on objects.

    Copies ``done/``, ``artifacts/`` pointers + referenced ``cas/`` blobs, and step
    meta for completed steps. New run continues from ``resume_step``.
    """
    if src.resolve() == dest.resolve():
        raise ValueError(f"clone_run_for_resume: src and dest are the same ({src})")
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "artifacts").mkdir(parents=True, exist_ok=True)
    (dest / "cas").mkdir(parents=True, exist_ok=True)
    (dest / "done").mkdir(parents=True, exist_ok=True)
    (dest / "steps").mkdir(parents=True, exist_ok=True)

    origin_run = pathspec(flow, source_run_id, resume_step)
    write_origin(
        dest,
        origin_pathspec=origin_run,
        source_run=source_run_id,
        resume_step=resume_step,
        cloned=True,
    )
    # carry user tags; refresh system
    src_tags = read_run_tags(src)
    write_run_tags(dest, user=src_tags["user"], system=[])
    set_system_tag(dest, "flow", _safe_name(flow))
    set_system_tag(dest, "cloned_from", source_run_id)

    # done markers
    src_done = src / "done"
    if src_done.is_dir():
        for p in src_done.iterdir():
            if p.is_file():
                shutil.copy2(p, dest / "done" / p.name)

    # step meta for done steps only
    src_steps = src / "steps"
    if src_steps.is_dir():
        for p in src_steps.glob("*.json"):
            if (dest / "done" / p.stem).is_file() or p.stem in done_steps(src):
                shutil.copy2(p, dest / "steps" / p.name)

    # artifacts + cas
    src_store = ArtifactStore(src)
    dest_store = ArtifactStore(dest)
    cloned_arts: list[str] = []
    for name in src_store.keys():
        aid = src_store.id_of(name)
        fmt = "json"
        ptr_src = src_store.dir / f"{_safe_name(name)}.json"
        body: dict[str, Any] = {}
        if ptr_src.is_file():
            try:
                raw = json.loads(ptr_src.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    body = dict(raw)
                    fmt = str(body.get("format") or "json")
            except json.JSONDecodeError:
                body = {}
        if aid:
            # copy cas blob
            sp = src_store._cas_path(aid)
            if sp.is_file():
                dp = dest_store._cas_path(aid)
                dp.parent.mkdir(parents=True, exist_ok=True)
                if not dp.is_file():
                    shutil.copy2(sp, dp)
            art_origin = pathspec(flow, source_run_id, artifact=name)
            body = {
                **body,
                "aq_cas": aid,
                "format": fmt,
                "origin_pathspec": art_origin,
                "at": _now(),
            }
            (dest_store.dir / f"{_safe_name(name)}.json").write_text(
                json.dumps(body, indent=2) + "\n", encoding="utf-8"
            )
            dest_store._update_index(name, aid, fmt)
            # stamp origin on index entry
            idx_path = dest / "cas_index.json"
            idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.is_file() else {}
            if isinstance(idx, dict) and name in idx and isinstance(idx[name], dict):
                idx[name]["origin_pathspec"] = art_origin
                idx_path.write_text(json.dumps(idx, indent=2) + "\n", encoding="utf-8")
            cloned_arts.append(name)
        else:
            # legacy raw file
            for suf in (".json", ".pkl"):
                sp = src_store.dir / f"{_safe_name(name)}{suf}"
                if sp.is_file():
                    shutil.copy2(sp, dest_store.dir / sp.name)
                    cloned_arts.append(name)
                    break

    # cursor for resume
    write_steps(
        dest,
        status="running",
        step=None,
        next_step=resume_step,
        done=done_steps(dest),
    )
    (dest / "next.json").write_text(
        json.dumps({"next": resume_step}, indent=2) + "\n", encoding="utf-8"
    )

    return {
        "origin_pathspec": origin_run,
        "source_run": source_run_id,
        "resume_step": resume_step,
        "cloned_artifacts": cloned_arts,
        "done": done_steps(dest),
    }


def attempt_root(run_root: Path, step: str, attempt: int) -> Path:
    """``attempts/<step>/<n>/`` — one dir per retry attempt."""
    return run_root / "attempts" / _safe_name(step) / str(int(attempt))


def make_attempt_store(run_root: Path, step: str, attempt: int) -> ArtifactStore:
    """Attempt-scoped pointer dir; CAS shared with the run."""
    root = attempt_root(run_root, step, attempt)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    return ArtifactStore(root, cas=run_root / "cas")


class LayeredStore:
    """Writes go to the attempt store; reads prefer attempt then main (visible)."""

    def __init__(self, main: ArtifactStore, attempt: ArtifactStore):
        self.main = main
        self.attempt = attempt

    def put(self, name: str, value: Any, *, origin_pathspec: str | None = None) -> Path:
        return self.attempt.put(name, value, origin_pathspec=origin_pathspec)

    def get(self, name: str) -> Any:
        try:
            return self.attempt.get(name)
        except KeyError:
            return self.main.get(name)

    def keys(self) -> list[str]:
        return sorted(set(self.main.keys()) | set(self.attempt.keys()))

    def load_all(self) -> dict[str, Any]:
        out = self.main.load_all()
        out.update(self.attempt.load_all())
        return out

    def ids(self) -> dict[str, str]:
        out = self.main.ids()
        out.update(self.attempt.ids())
        return out

    def id_of(self, name: str) -> str | None:
        return self.attempt.id_of(name) or self.main.id_of(name)

    def verify(self) -> dict[str, Any]:
        return self.main.verify()


def promote_attempt(main: ArtifactStore, attempt: ArtifactStore) -> list[str]:
    """Copy attempt outputs into the run's visible ``artifacts/`` (CAS dedupes)."""
    promoted: list[str] = []
    for name in attempt.keys():
        main.put(name, attempt.get(name))
        promoted.append(name)
    return promoted


def write_attempt_meta(
    run_root: Path,
    step: str,
    attempt: int,
    *,
    status: str,
    error: str | None = None,
    artifacts: list[str] | None = None,
    visible: bool = False,
) -> dict[str, Any]:
    """Record one retry attempt under ``attempts/<step>/<n>/meta.json``."""
    root = attempt_root(run_root, step, attempt)
    root.mkdir(parents=True, exist_ok=True)
    body: dict[str, Any] = {
        "step": step,
        "attempt": attempt,
        "status": status,
        "visible": visible,
        "at": _now(),
        "artifacts": list(artifacts or []),
    }
    if error:
        body["error"] = error
    (root / "meta.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    if visible:
        vis = run_root / "attempts" / _safe_name(step) / "visible.json"
        vis.parent.mkdir(parents=True, exist_ok=True)
        vis.write_text(
            json.dumps({"attempt": attempt, "at": _now()}, indent=2) + "\n",
            encoding="utf-8",
        )
    return body


def read_visible_attempt(run_root: Path, step: str) -> int | None:
    p = run_root / "attempts" / _safe_name(step) / "visible.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and data.get("attempt") is not None:
        return int(data["attempt"])
    return None
