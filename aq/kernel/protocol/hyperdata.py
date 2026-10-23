"""Hyper-Datasets — media + annotations with folder-native views.

Layout (optional):
  data/media/… or recipe data.path (ImageFolder / flat files)
  data/annotations/*.jsonl   # {id|path, label?, tags?, …}
  data/views/<name>.yaml     # filter / query / oversample / debias
  data/views/<name>/selection.jsonl   # materialized id list (after apply)

Views never copy lakes: selection rows point at relative media paths.
Train lineage hashes the selection (+ base media/annotation digests).
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

def _scalar(v: str) -> Any:
    s = v.strip()
    if s in ("null", "None", "~", ""):
        return None
    if s in ("true", "yes"):
        return True
    if s in ("false", "no"):
        return False
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_scalar(x) for x in inner.split(",")]
    try:
        if "." in s:
            return float(s)
        return int(s)
    except ValueError:
        return s.strip("'\"")


def _load_yaml(path: Path) -> dict[str, Any]:
    """Parse view specs: PyYAML if present, else indent-aware subset (like recipe.py)."""
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        body = yaml.safe_load(text)
        return body if isinstance(body, dict) else {}
    except Exception:
        pass
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        key = stripped.strip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        cur = stack[-1][1]
        if key.endswith(":") and ":" == key[-1] and key.count(":") == 1:
            name = key[:-1].strip()
            child: dict[str, Any] = {}
            cur[name] = child
            stack.append((indent, child))
            continue
        if ":" not in key:
            continue
        k, _, v = key.partition(":")
        cur[k.strip()] = _scalar(v)
    return root


def views_dir(train: Path) -> Path:
    return train / "data" / "views"


def view_spec_path(train: Path, name: str) -> Path:
    n = name.strip().removesuffix(".yaml").removesuffix(".yml")
    return views_dir(train) / f"{n}.yaml"


def view_out_dir(train: Path, name: str) -> Path:
    n = name.strip().removesuffix(".yaml").removesuffix(".yml")
    return views_dir(train) / n


def selection_path(train: Path, name: str) -> Path:
    return view_out_dir(train, name) / "selection.jsonl"


def list_views(train: Path) -> list[dict[str, Any]]:
    d = views_dir(train)
    if not d.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(d.glob("*.yaml")) + sorted(d.glob("*.yml")):
        spec = _load_yaml(p)
        name = p.stem
        sel = selection_path(train, name)
        out.append(
            {
                "name": name,
                "spec": f"data/views/{p.name}",
                "selection": f"data/views/{name}/selection.jsonl" if sel.is_file() else None,
                "n": _count_jsonl(sel) if sel.is_file() else None,
                "filter": spec.get("filter"),
                "query": spec.get("query"),
                "oversample": spec.get("oversample"),
                "debias": spec.get("debias") or spec.get("de-bias"),
            }
        )
    return out


def _count_jsonl(path: Path) -> int:
    n = 0
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.strip():
                n += 1
    return n


def index_media(train: Path, media_rel: str) -> list[dict[str, Any]]:
    """Index files under media root; ImageFolder dirs become ``label``."""
    root = (train / media_rel).resolve()
    if not root.exists():
        raise SystemExit(f"media path not found: {media_rel}")
    rows: list[dict[str, Any]] = []
    if root.is_file():
        rel = media_rel
        rows.append({"id": Path(rel).name, "path": rel, "label": None})
        return rows
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        under = f.relative_to(root).as_posix()
        if under == "revision.json" or under.startswith("revisions/") or under.startswith("views/"):
            continue
        try:
            rel = f.relative_to(train).as_posix()
        except ValueError:
            rel = f.as_posix()
        parts = under.split("/")
        label = parts[0] if len(parts) > 1 else None
        rows.append({"id": under, "path": rel, "label": label})
    return rows


def load_annotations(train: Path, ann_rel: str | None) -> dict[str, dict[str, Any]]:
    """Map id/path → annotation row from json/jsonl."""
    if not ann_rel:
        return {}
    path = (train / ann_rel).resolve()
    if not path.exists():
        raise SystemExit(f"annotations not found: {ann_rel}")
    rows: list[dict[str, Any]] = []
    if path.suffix.lower() == ".jsonl":
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    rows.append(obj)
    else:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            rows = [r for r in raw if isinstance(r, dict)]
        elif isinstance(raw, dict):
            # {id: {…}} or {items: [...]}
            if "items" in raw and isinstance(raw["items"], list):
                rows = [r for r in raw["items"] if isinstance(r, dict)]
            else:
                for k, v in raw.items():
                    if isinstance(v, dict):
                        rows.append({"id": k, **v})
                    else:
                        rows.append({"id": k, "label": v})
    by: dict[str, dict[str, Any]] = {}
    for r in rows:
        keys = []
        for k in ("id", "path", "file", "image"):
            if r.get(k):
                keys.append(str(r[k]))
        if not keys:
            continue
        for key in keys:
            by[key] = r
            # also bare filename
            by[Path(key).name] = r
    return by


def merge_index(
    media_rows: list[dict[str, Any]],
    anns: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in media_rows:
        merged = dict(row)
        hit = (
            anns.get(str(row.get("id") or ""))
            or anns.get(str(row.get("path") or ""))
            or anns.get(Path(str(row.get("path") or "")).name)
        )
        if hit:
            for k, v in hit.items():
                if k in ("id", "path") and merged.get(k):
                    continue
                merged[k] = v
        out.append(merged)
    # annotation-only rows (no media file) — keep if they have path
    seen = {str(r.get("id") or r.get("path")) for r in out}
    for key, ann in anns.items():
        ident = str(ann.get("id") or ann.get("path") or key)
        if ident in seen:
            continue
        if ann.get("path") or ann.get("image"):
            out.append(dict(ann))
            seen.add(ident)
    return out


def _match_filter(row: dict[str, Any], filt: dict[str, Any]) -> bool:
    for key, want in filt.items():
        if key in ("query", "where"):
            continue
        val = row.get(key)
        if isinstance(want, list):
            if val not in want and str(val) not in [str(w) for w in want]:
                # tags_any special-case
                if key.endswith("_any") or key == "tags":
                    tags = row.get("tags") or row.get(key.replace("_any", "")) or []
                    if not isinstance(tags, list):
                        tags = [tags]
                    if not any(t in want or str(t) in [str(w) for w in want] for t in tags):
                        return False
                    continue
                return False
        elif isinstance(want, dict):
            # {eq: x} / {ne: x} / {in: [...]} / {contains: x}
            if "eq" in want and val != want["eq"] and str(val) != str(want["eq"]):
                return False
            if "ne" in want and (val == want["ne"] or str(val) == str(want["ne"])):
                return False
            if "in" in want:
                opts = want["in"]
                if val not in opts and str(val) not in [str(o) for o in opts]:
                    return False
            if "contains" in want:
                needle = str(want["contains"])
                hay = val if isinstance(val, list) else [val]
                if needle not in [str(x) for x in hay]:
                    return False
        else:
            if val != want and str(val) != str(want):
                return False
    return True


_QUERY_RE = re.compile(
    r"^\s*(\w+)\s*(==|!=|in)\s*(.+?)\s*$",
    re.IGNORECASE,
)


def _eval_query(row: dict[str, Any], query: str) -> bool:
    """Tiny query language: ``label == circle``, ``label != other``, ``label in a,b``."""
    q = query.strip()
    if not q:
        return True
    # AND of clauses separated by &&
    for part in re.split(r"\s*&&\s*", q):
        m = _QUERY_RE.match(part.strip())
        if not m:
            raise SystemExit(f"unsupported query clause: {part!r} (use field ==|!=|in value)")
        field, op, raw = m.group(1), m.group(2).lower(), m.group(3).strip()
        val = row.get(field)
        if op == "in":
            opts = [x.strip().strip("'\"") for x in raw.strip("[]()").split(",") if x.strip()]
            if val not in opts and str(val) not in opts:
                return False
        else:
            want = raw.strip().strip("'\"")
            ok = val == want or str(val) == want
            if op == "==" and not ok:
                return False
            if op == "!=" and ok:
                return False
    return True


def apply_filter(
    rows: list[dict[str, Any]],
    *,
    filt: dict[str, Any] | None = None,
    query: str | None = None,
) -> list[dict[str, Any]]:
    out = rows
    if filt:
        q = filt.get("query") or filt.get("where")
        field_filt = {k: v for k, v in filt.items() if k not in ("query", "where")}
        if field_filt:
            out = [r for r in out if _match_filter(r, field_filt)]
        if isinstance(q, str) and q.strip():
            out = [r for r in out if _eval_query(r, q)]
    if query and str(query).strip():
        out = [r for r in out if _eval_query(r, str(query))]
    return out


def oversample(
    rows: list[dict[str, Any]],
    *,
    by: str = "label",
    target: str | int = "max",
    seed: int = 0,
) -> list[dict[str, Any]]:
    """Upsample minority groups to ``target`` (``max`` or absolute count)."""
    groups: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[r.get(by)].append(r)
    if not groups:
        return rows
    if target == "max":
        n_tgt = max(len(g) for g in groups.values())
    else:
        n_tgt = int(target)
    rng = random.Random(seed)
    out: list[dict[str, Any]] = []
    for _, g in sorted(groups.items(), key=lambda kv: str(kv[0])):
        if not g:
            continue
        if len(g) >= n_tgt:
            out.extend(g[:n_tgt] if isinstance(target, int) else g)
        else:
            out.extend(g)
            need = n_tgt - len(g)
            out.extend(rng.choices(g, k=need))
    rng.shuffle(out)
    return out


def debias(
    rows: list[dict[str, Any]],
    *,
    by: str = "label",
    strategy: str = "equal",
    seed: int = 0,
) -> list[dict[str, Any]]:
    """Downsample to balance groups (``equal`` = minority size)."""
    groups: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[r.get(by)].append(r)
    if not groups:
        return rows
    rng = random.Random(seed)
    if strategy in ("equal", "min", "downsample"):
        n = min(len(g) for g in groups.values())
    else:
        n = int(strategy)
    out: list[dict[str, Any]] = []
    for _, g in sorted(groups.items(), key=lambda kv: str(kv[0])):
        g2 = list(g)
        rng.shuffle(g2)
        out.extend(g2[:n])
    rng.shuffle(out)
    return out


def load_view_spec(train: Path, name: str) -> dict[str, Any]:
    path = view_spec_path(train, name)
    if not path.is_file():
        # also allow data/views/<name>/view.yaml
        alt = view_out_dir(train, name) / "view.yaml"
        if alt.is_file():
            path = alt
        else:
            raise SystemExit(f"view not found: data/views/{name}.yaml")
    spec = _load_yaml(path)
    spec["_name"] = path.stem
    spec["_spec_path"] = path.relative_to(train).as_posix()
    return spec


def resolve_view(
    train: Path,
    name: str,
    *,
    recipe: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve view → filtered/sampled rows + stats (no write)."""
    from protocol.recipe import load_recipe

    rec = recipe if recipe is not None else load_recipe(train)
    data_cfg = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    spec = load_view_spec(train, name)
    media_rel = str(spec.get("media") or spec.get("path") or data_cfg.get("path") or "")
    if not media_rel:
        raise SystemExit("view needs media: or recipe data.path")
    ann_rel = spec.get("annotations") or spec.get("ann") or data_cfg.get("annotations")
    if ann_rel is not None:
        ann_rel = str(ann_rel)

    media_rows = index_media(train, media_rel)
    anns = load_annotations(train, ann_rel)
    rows = merge_index(media_rows, anns)
    n_base = len(rows)

    filt = spec.get("filter") if isinstance(spec.get("filter"), dict) else None
    query = spec.get("query") or spec.get("where")
    rows = apply_filter(rows, filt=filt, query=str(query) if query else None)
    n_filtered = len(rows)

    seed = int(spec.get("seed") or 0)
    if spec.get("oversample"):
        ov = spec["oversample"]
        if not isinstance(ov, dict):
            ov = {"by": "label", "target": "max"}
        rows = oversample(
            rows,
            by=str(ov.get("by") or "label"),
            target=ov.get("target", "max"),
            seed=int(ov.get("seed", seed)),
        )
    deb = spec.get("debias") or spec.get("de-bias")
    if deb:
        if not isinstance(deb, dict):
            deb = {"by": "label", "strategy": "equal"}
        rows = debias(
            rows,
            by=str(deb.get("by") or "label"),
            strategy=str(deb.get("strategy") or "equal"),
            seed=int(deb.get("seed", seed)),
        )

    labels = Counter(str(r.get("label")) for r in rows)
    return {
        "name": spec["_name"],
        "spec": spec["_spec_path"],
        "media": media_rel,
        "annotations": ann_rel,
        "n_base": n_base,
        "n_filtered": n_filtered,
        "n": len(rows),
        "labels": dict(labels),
        "rows": rows,
        "seed": seed,
        "filter": filt,
        "query": query,
        "oversample": spec.get("oversample"),
        "debias": deb,
    }


def _hash_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _hash_file_rel(train: Path, rel: str | None) -> str | None:
    if not rel:
        return None
    from protocol.revision import hash_file, hash_tree

    p = (train / rel).resolve()
    if not p.exists():
        return None
    if p.is_file():
        d, _ = hash_file(p)
        return "sha256:" + d
    d, _, _ = hash_tree(p)
    return "sha256:" + d


def materialize_view(
    train: Path,
    name: str,
    *,
    recipe: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write ``data/views/<name>/selection.jsonl`` + ``meta.json``; return summary."""
    resolved = resolve_view(train, name, recipe=recipe)
    out_dir = view_out_dir(train, name)
    out_dir.mkdir(parents=True, exist_ok=True)
    sel = selection_path(train, name)
    lines = []
    for r in resolved["rows"]:
        lines.append(json.dumps(r, sort_keys=True, ensure_ascii=False))
    payload = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
    sel.write_text(payload.decode("utf-8"), encoding="utf-8")

    media_hash = _hash_file_rel(train, resolved["media"])
    ann_hash = _hash_file_rel(train, resolved.get("annotations"))
    spec_hash = _hash_file_rel(train, resolved["spec"])
    sel_digest = hashlib.sha256(payload).hexdigest()
    # composite view identity
    h = hashlib.sha256()
    h.update(b"aq-hyperview-v1\0")
    for part in (media_hash, ann_hash, spec_hash, "sha256:" + sel_digest):
        h.update((part or "").encode())
        h.update(b"\0")
    view_hash = "sha256:" + h.hexdigest()

    meta = {
        "name": resolved["name"],
        "spec": resolved["spec"],
        "selection": f"data/views/{resolved['name']}/selection.jsonl",
        "media": resolved["media"],
        "annotations": resolved.get("annotations"),
        "media_hash": media_hash,
        "annotations_hash": ann_hash,
        "spec_hash": spec_hash,
        "selection_hash": "sha256:" + sel_digest,
        "hash": view_hash,
        "n": resolved["n"],
        "n_base": resolved["n_base"],
        "n_filtered": resolved["n_filtered"],
        "labels": resolved["labels"],
        "filter": resolved.get("filter"),
        "query": resolved.get("query"),
        "oversample": resolved.get("oversample"),
        "debias": resolved.get("debias"),
        "at": datetime.now(timezone.utc).isoformat(),
        "kind": "hyperview",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def show_view(train: Path, name: str) -> dict[str, Any]:
    meta_path = view_out_dir(train, name) / "meta.json"
    if meta_path.is_file():
        try:
            body = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(body, dict):
                return body
        except json.JSONDecodeError:
            pass
    # resolve without requiring materialize
    resolved = resolve_view(train, name)
    resolved.pop("rows", None)
    return resolved


def format_view_list(rows: list[dict[str, Any]]) -> list[str]:
    from protocol.term_table import render_table

    if not rows:
        return ["hyper-datasets", "  (no data/views/*.yaml yet)"]
    table = []
    for r in rows:
        table.append(
            [
                r.get("name"),
                r.get("n") if r.get("n") is not None else "—",
                "yes" if r.get("selection") else "—",
                r.get("spec"),
            ]
        )
    return ["hyper-datasets", render_table(("name", "n", "applied", "spec"), table)]


def format_view_show(meta: dict[str, Any]) -> list[str]:
    from protocol.term_table import render_table

    keys = (
        "name",
        "hash",
        "media",
        "annotations",
        "selection",
        "n",
        "n_base",
        "n_filtered",
        "query",
        "spec",
        "at",
    )
    kv = [(k, meta[k]) for k in keys if meta.get(k) is not None]
    if meta.get("labels"):
        kv.append(("labels", json.dumps(meta["labels"], sort_keys=True)))
    if meta.get("filter"):
        kv.append(("filter", json.dumps(meta["filter"], sort_keys=True)))
    if meta.get("oversample"):
        kv.append(("oversample", json.dumps(meta["oversample"], sort_keys=True)))
    if meta.get("debias"):
        kv.append(("debias", json.dumps(meta["debias"], sort_keys=True)))
    return ["view", render_table(("key", "value"), kv)]


def list_train(train: Path) -> list[str]:
    return format_view_list(list_views(train))


def show_train(train: Path, name: str) -> list[str]:
    return format_view_show(show_view(train, name))


def apply_train(train: Path, name: str) -> list[str]:
    meta = materialize_view(train, name)
    return format_view_show(meta) + ["file", f"  {meta.get('selection')}", f"  data/views/{meta['name']}/meta.json"]
