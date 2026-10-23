"""Vector similarity over media rows — near-dupes / hard examples for views.

Folder-native index: ``data/embeddings/<name>.jsonl`` (+ ``.meta.json``).
Default embedder is a cheap thumbnail vector (Pillow if present, else byte hist).
Optional ``embed: bytes`` is content-agnostic; no GPU required.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def embeddings_dir(train: Path) -> Path:
    return train / "data" / "embeddings"


def index_paths(train: Path, name: str = "default") -> tuple[Path, Path]:
    d = embeddings_dir(train)
    return d / f"{name}.jsonl", d / f"{name}.meta.json"


def _l2_normalize(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def _cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        m = min(len(a), len(b))
        a, b = a[:m], b[:m]
    return sum(x * y for x, y in zip(a, b))


def embed_bytes(path: Path, *, dim: int = 64) -> list[float]:
    """Stable byte-histogram embedding (works for any file)."""
    hist = [0.0] * dim
    with path.open("rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            for i, b in enumerate(chunk):
                hist[(b + i) % dim] += 1.0
    return _l2_normalize(hist)


def embed_thumb(path: Path, *, size: int = 8) -> list[float]:
    """8×8 grayscale thumbnail → unit vector. Falls back to ``embed_bytes``."""
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        return embed_bytes(path, dim=size * size)
    try:
        with Image.open(path) as im:
            g = im.convert("L").resize((size, size))
            pix = list(g.getdata())
        mean = sum(pix) / len(pix) if pix else 0.0
        # mean-center then normalize (phash-ish)
        centered = [float(p) - mean for p in pix]
        return _l2_normalize(centered)
    except Exception:
        return embed_bytes(path, dim=size * size)


def embed_text(text: str, *, dim: int = 128) -> list[float]:
    """Char trigram hash embedding for text rows."""
    hist = [0.0] * dim
    s = (text or "").lower()
    padded = f"  {s}  "
    for i in range(len(padded) - 2):
        tri = padded[i : i + 3]
        h = int(hashlib.md5(tri.encode()).hexdigest(), 16)
        hist[h % dim] += 1.0
    return _l2_normalize(hist)


def embed_row(train: Path, row: dict[str, Any], *, method: str = "thumb") -> list[float]:
    method = (method or "thumb").lower()
    path_rel = row.get("path") or row.get("image") or row.get("file")
    if path_rel and method in ("thumb", "phash", "image"):
        p = (train / str(path_rel)).resolve()
        if p.is_file():
            return embed_thumb(p) if method != "bytes" else embed_bytes(p)
    if path_rel and method == "bytes":
        p = (train / str(path_rel)).resolve()
        if p.is_file():
            return embed_bytes(p)
    # text fields
    for key in ("text", "prompt", "caption", "label"):
        if row.get(key) is not None:
            return embed_text(str(row[key]))
    if path_rel:
        p = (train / str(path_rel)).resolve()
        if p.is_file():
            return embed_bytes(p)
    return embed_text(json.dumps(row, sort_keys=True))


def build_index(
    train: Path,
    rows: list[dict[str, Any]],
    *,
    name: str = "default",
    embed: str = "thumb",
) -> dict[str, Any]:
    """Write embedding index for rows; return meta."""
    jsonl, meta_path = index_paths(train, name)
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with jsonl.open("w", encoding="utf-8") as f:
        for row in rows:
            ident = str(row.get("id") or row.get("path") or "")
            if not ident:
                continue
            vec = embed_row(train, row, method=embed)
            rec = {
                "id": ident,
                "path": row.get("path"),
                "label": row.get("label"),
                "vec": vec,
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    meta = {
        "name": name,
        "path": f"data/embeddings/{name}.jsonl",
        "embed": embed,
        "n": n,
        "dim": len(vec) if n else 0,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def load_index(train: Path, name: str = "default") -> list[dict[str, Any]]:
    jsonl, _ = index_paths(train, name)
    if not jsonl.is_file():
        return []
    out: list[dict[str, Any]] = []
    with jsonl.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and isinstance(obj.get("vec"), list):
                out.append(obj)
    return out


def ensure_index(
    train: Path,
    rows: list[dict[str, Any]],
    *,
    name: str = "default",
    embed: str = "thumb",
    rebuild: bool = False,
) -> list[dict[str, Any]]:
    jsonl, meta_path = index_paths(train, name)
    if rebuild or not jsonl.is_file():
        build_index(train, rows, name=name, embed=embed)
        return load_index(train, name)
    # rebuild if count drifted
    indexed = load_index(train, name)
    if len(indexed) != len(rows):
        build_index(train, rows, name=name, embed=embed)
        return load_index(train, name)
    return indexed


def _row_key(row: dict[str, Any]) -> str:
    return str(row.get("id") or row.get("path") or "")


def nearest(
    index: list[dict[str, Any]],
    query_vec: list[float],
    *,
    k: int = 10,
    exclude: set[str] | None = None,
) -> list[tuple[float, dict[str, Any]]]:
    exclude = exclude or set()
    scored: list[tuple[float, dict[str, Any]]] = []
    for rec in index:
        rid = str(rec.get("id") or "")
        if rid in exclude:
            continue
        scored.append((_cosine(query_vec, rec["vec"]), rec))
    scored.sort(key=lambda t: t[0], reverse=True)
    return scored[: max(0, k)]


def dedupe_rows(
    rows: list[dict[str, Any]],
    index: list[dict[str, Any]],
    *,
    threshold: float = 0.95,
) -> list[dict[str, Any]]:
    """Keep one row per near-duplicate cluster (greedy by index order)."""
    by_id = {str(r.get("id") or ""): r for r in index}
    kept_ids: list[str] = []
    kept_vecs: list[list[float]] = []
    out: list[dict[str, Any]] = []
    row_by = {_row_key(r): r for r in rows}
    for row in rows:
        key = _row_key(row)
        rec = by_id.get(key)
        if not rec:
            out.append(row)
            continue
        vec = rec["vec"]
        dup = False
        for kv in kept_vecs:
            if _cosine(vec, kv) >= threshold:
                dup = True
                break
        if dup:
            continue
        kept_ids.append(key)
        kept_vecs.append(vec)
        out.append(row_by.get(key, row))
    return out


def hard_example_rows(
    rows: list[dict[str, Any]],
    index: list[dict[str, Any]],
    seeds: list[dict[str, Any]],
    *,
    k: int = 20,
    per_seed: int | None = None,
) -> list[dict[str, Any]]:
    """Rows nearest to seed set (hard examples / neighbors of failures)."""
    by_id = {_row_key(r): r for r in rows}
    idx_by = {str(r.get("id") or ""): r for r in index}
    seed_ids = set()
    seed_vecs: list[list[float]] = []
    for s in seeds:
        key = _row_key(s)
        seed_ids.add(key)
        rec = idx_by.get(key)
        if rec:
            seed_vecs.append(rec["vec"])
        elif s.get("vec"):
            seed_vecs.append(list(s["vec"]))
    if not seed_vecs:
        return []
    per = per_seed if per_seed is not None else max(1, math.ceil(k / max(1, len(seed_vecs))))
    seen: set[str] = set(seed_ids)
    scored: list[tuple[float, str]] = []
    for sv in seed_vecs:
        for sim, rec in nearest(index, sv, k=per + len(seed_ids), exclude=seed_ids):
            rid = str(rec.get("id") or "")
            if rid in seen:
                continue
            scored.append((sim, rid))
    scored.sort(key=lambda t: t[0], reverse=True)
    out: list[dict[str, Any]] = []
    for _, rid in scored:
        if rid in seen:
            continue
        seen.add(rid)
        if rid in by_id:
            out.append(by_id[rid])
        if len(out) >= k:
            break
    return out


def load_seed_rows(train: Path, seeds_spec: Any) -> list[dict[str, Any]]:
    """Seeds from path / selection.jsonl / list of ids or paths."""
    if seeds_spec is None:
        return []
    if isinstance(seeds_spec, list):
        out = []
        for item in seeds_spec:
            if isinstance(item, dict):
                out.append(item)
            else:
                s = str(item)
                out.append({"id": s, "path": s})
        return out
    rel = str(seeds_spec)
    path = (train / rel).resolve()
    if not path.is_file():
        raise SystemExit(f"similar seeds not found: {rel}")
    if path.suffix.lower() == ".jsonl":
        rows = []
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
        return rows
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        return [r for r in raw["items"] if isinstance(r, dict)]
    return []


def apply_similar(
    train: Path,
    rows: list[dict[str, Any]],
    similar: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply ``similar:`` view block → filtered rows + stats."""
    mode = str(similar.get("mode") or similar.get("op") or "dedupe").lower()
    embed = str(similar.get("embed") or "thumb")
    index_name = str(similar.get("index") or "default")
    rebuild = bool(similar.get("rebuild"))
    index = ensure_index(train, rows, name=index_name, embed=embed, rebuild=rebuild)
    stats: dict[str, Any] = {
        "mode": mode,
        "embed": embed,
        "index": f"data/embeddings/{index_name}.jsonl",
        "n_in": len(rows),
    }
    if mode in ("dedupe", "near-dupe", "near_dupes", "duplicates"):
        thr = float(similar.get("threshold") or similar.get("min_sim") or 0.95)
        out = dedupe_rows(rows, index, threshold=thr)
        stats["threshold"] = thr
        stats["n_out"] = len(out)
        stats["removed"] = len(rows) - len(out)
        return out, stats
    if mode in ("hard", "hard_examples", "nn", "neighbors"):
        seeds = load_seed_rows(train, similar.get("seeds") or similar.get("seed"))
        k = int(similar.get("k") or similar.get("top_k") or 20)
        out = hard_example_rows(rows, index, seeds, k=k, per_seed=similar.get("per_seed"))
        # optionally keep seeds too
        if similar.get("include_seeds"):
            seen = {_row_key(r) for r in out}
            for s in seeds:
                key = _row_key(s)
                if key not in seen:
                    # prefer full row from pool
                    for r in rows:
                        if _row_key(r) == key:
                            out.insert(0, r)
                            seen.add(key)
                            break
        stats["k"] = k
        stats["n_seeds"] = len(seeds)
        stats["n_out"] = len(out)
        return out, stats
    if mode in ("search", "query"):
        qpath = similar.get("query") or similar.get("path")
        if not qpath:
            raise SystemExit("similar.mode=search needs query: path")
        qrow = {"id": str(qpath), "path": str(qpath)}
        # allow id match in rows
        for r in rows:
            if _row_key(r) == str(qpath) or str(r.get("path")) == str(qpath):
                qrow = r
                break
        qvec = embed_row(train, qrow, method=embed)
        k = int(similar.get("k") or 10)
        hits = nearest(index, qvec, k=k, exclude={_row_key(qrow)} if similar.get("exclude_self", True) else set())
        out = []
        by = {_row_key(r): r for r in rows}
        for sim, rec in hits:
            rid = str(rec.get("id") or "")
            row = by.get(rid, {"id": rid, "path": rec.get("path"), "label": rec.get("label")})
            row = dict(row)
            row["similarity"] = round(sim, 6)
            out.append(row)
        stats["k"] = k
        stats["query"] = str(qpath)
        stats["n_out"] = len(out)
        return out, stats
    raise SystemExit(f"unknown similar.mode: {mode!r} (dedupe|hard|search)")


def format_similar_stats(stats: dict[str, Any]) -> list[str]:
    from protocol.term_table import render_table

    kv = [(k, stats[k]) for k in ("mode", "embed", "index", "threshold", "k", "n_seeds", "n_in", "n_out", "removed", "query") if k in stats]
    return ["similar", render_table(("key", "value"), kv)]


def _pool_rows(train: Path, media: str | None = None) -> list[dict[str, Any]]:
    from protocol.hyperdata import index_media, load_annotations, merge_index
    from protocol.recipe import load_recipe

    rec = load_recipe(train)
    data_cfg = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    media_rel = media or str(data_cfg.get("path") or "")
    if not media_rel:
        raise SystemExit("need media path or recipe data.path")
    ann = data_cfg.get("annotations")
    return merge_index(index_media(train, media_rel), load_annotations(train, str(ann) if ann else None))


def build_train(train: Path, *, name: str = "default", embed: str = "thumb", media: str | None = None) -> list[str]:
    rows = _pool_rows(train, media)
    meta = build_index(train, rows, name=name, embed=embed)
    from protocol.term_table import render_table

    kv = [(k, meta[k]) for k in ("name", "path", "embed", "n", "dim", "at") if k in meta]
    return ["embeddings", render_table(("key", "value"), kv), "file", f"  {meta['path']}"]


def search_train(
    train: Path,
    query: str,
    *,
    k: int = 10,
    embed: str = "thumb",
    index: str = "default",
) -> list[str]:
    rows = _pool_rows(train)
    idx = ensure_index(train, rows, name=index, embed=embed)
    out, stats = apply_similar(
        train,
        rows,
        {"mode": "search", "query": query, "k": k, "embed": embed, "index": index},
    )
    from protocol.term_table import render_table

    lines = format_similar_stats(stats)
    table = [[r.get("similarity"), r.get("label") or "—", r.get("path") or r.get("id")] for r in out]
    if table:
        lines.append(render_table(("sim", "label", "path"), table))
    return lines


def dedupe_train(
    train: Path,
    *,
    threshold: float = 0.95,
    embed: str = "thumb",
    index: str = "default",
) -> list[str]:
    rows = _pool_rows(train)
    ensure_index(train, rows, name=index, embed=embed)
    out, stats = apply_similar(
        train,
        rows,
        {"mode": "dedupe", "threshold": threshold, "embed": embed, "index": index},
    )
    return format_similar_stats(stats) + [f"  kept {len(out)} / {stats.get('n_in')}"]
