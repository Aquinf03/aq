#!/usr/bin/env python3
"""Hash + inspect recipe data.path. Writes data/revision.json; CLI shows a clear table."""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.recipe import load_recipe
from protocol.paths import art_dir

SKIP_NAMES = {"revision.json"}
SKIP_PREFIX = "revisions/"


def hash_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


def skip_rel(rel: str) -> bool:
    return rel in SKIP_NAMES or rel.startswith(SKIP_PREFIX)


def hash_tree(path: Path) -> tuple[str, int, int]:
    if path.is_file():
        digest, n = hash_file(path)
        return digest, n, 1
    if not path.is_dir():
        raise SystemExit(f"not a file or directory: {path}")
    h = hashlib.sha256()
    total = 0
    files = 0
    for f in sorted(p for p in path.rglob("*") if p.is_file()):
        rel = f.relative_to(path).as_posix()
        if skip_rel(rel):
            continue
        digest, n = hash_file(f)
        h.update(rel.encode())
        h.update(b"\0")
        h.update(digest.encode())
        h.update(b"\n")
        total += n
        files += 1
    return h.hexdigest(), total, files


def snapshot_copy(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    if src.is_file():
        shutil.copy2(src, dest / src.name)
        return
    for f in src.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(src).as_posix()
        if skip_rel(rel):
            continue
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, out)


def inspect_data(src: Path, data_cfg: dict | None = None) -> dict[str, Any]:
    """Lightweight schema / count stats (no second full pass beyond what we need)."""
    cfg = data_cfg if isinstance(data_cfg, dict) else {}
    out: dict[str, Any] = {"kind": "file" if src.is_file() else "dir"}
    target = cfg.get("target")
    if target is not None:
        out["target"] = str(target)
    for key in ("text", "src", "tgt", "prompt", "completion", "image"):
        if cfg.get(key) is not None:
            out[key] = str(cfg[key])

    if src.is_dir():
        files = [p for p in src.rglob("*") if p.is_file() and not skip_rel(p.relative_to(src).as_posix())]
        out["n_files"] = len(files)
        # ImageFolder-ish: top-level class dirs
        subs = [p.name for p in sorted(src.iterdir()) if p.is_dir() and not p.name.startswith(".")]
        if subs:
            out["classes"] = subs[:64]
            out["n_classes"] = len(subs)
        return out

    suffix = src.suffix.lower()
    out["format"] = suffix.lstrip(".") or "file"
    try:
        if suffix == ".csv":
            with src.open(newline="", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                headers = next(reader, None)
                n = 0
                for _ in reader:
                    n += 1
            if headers:
                out["columns"] = [str(h) for h in headers]
                out["n_columns"] = len(headers)
            out["n"] = n
        elif suffix == ".jsonl":
            n = 0
            cols: list[str] | None = None
            with src.open(encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not line.strip():
                        continue
                    n += 1
                    if cols is None:
                        try:
                            row = json.loads(line)
                            if isinstance(row, dict):
                                cols = list(row.keys())
                        except json.JSONDecodeError:
                            pass
            out["n"] = n
            if cols:
                out["columns"] = cols
                out["n_columns"] = len(cols)
        elif suffix == ".json":
            raw = json.loads(src.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                out["n"] = len(raw)
                if raw and isinstance(raw[0], dict):
                    out["columns"] = list(raw[0].keys())
                    out["n_columns"] = len(out["columns"])
            elif isinstance(raw, dict):
                out["keys"] = list(raw.keys())[:64]
    except Exception as e:
        out["inspect_error"] = str(e)[:200]
    return out


def revision_path(train: Path) -> Path:
    return train / "data" / "revision.json"


def load_revision(train: Path) -> dict[str, Any] | None:
    p = revision_path(train)
    if not p.is_file():
        return None
    try:
        body = json.loads(p.read_text(encoding="utf-8"))
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


def build_revision(
    train: Path,
    *,
    snapshot: bool = False,
    write: bool = True,
) -> dict[str, Any]:
    """Hash + inspect recipe data.path → revision dict (and optional data/revision.json)."""
    recipe = load_recipe(train)
    data_cfg = recipe.get("data") if isinstance(recipe.get("data"), dict) else {}
    rel = str((data_cfg or {}).get("path") or "")
    if not rel:
        raise SystemExit("recipe.yaml has no data.path")
    src = (train / rel).resolve()
    if not src.exists():
        raise SystemExit(f"data path not found: {rel}")

    digest, nbytes, nfiles = hash_tree(src)
    hid = "sha256:" + digest
    snap_rel = None
    if snapshot:
        snap_rel = f"data/revisions/{digest}"
        snapshot_copy(src, train / snap_rel)

    body: dict[str, Any] = {
        "path": rel,
        "hash": hid,
        "bytes": nbytes,
        "files": nfiles,
        "snapshot": snap_rel,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    body.update(inspect_data(src, data_cfg))

    tok = art_dir(train) / "tokenizer.json"
    if tok.is_file():
        td, _ = hash_file(tok)
        body["tokenizer"] = "sha256:" + td
        body["tokenizer_path"] = "artifacts/tokenizer.json"

    if write:
        dest = revision_path(train)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return body


def data_identity(train: Path, rec: dict | None = None, *, refresh: bool = False) -> dict[str, Any] | None:
    """Rich data block for run records. Uses revision.json when path matches."""
    if rec is None:
        try:
            rec = load_recipe(train)
        except Exception:
            rec = {}
    rel = (rec.get("data") or {}).get("path") if isinstance(rec, dict) else None
    if not rel:
        return None
    src = (train / str(rel)).resolve()
    if not src.exists():
        return None

    existing = load_revision(train)
    if (
        not refresh
        and existing
        and existing.get("path") == str(rel)
        and existing.get("hash")
    ):
        return existing
    try:
        return build_revision(train, snapshot=False, write=True)
    except SystemExit:
        # Fall back to hash-only if recipe load issues mid-run
        digest, nbytes, nfiles = hash_tree(src)
        return {
            "path": str(rel),
            "hash": "sha256:" + digest,
            "bytes": nbytes,
            "files": nfiles,
        }


def format_revision_lines(body: dict[str, Any]) -> list[str]:
    """CLI/TUI lines for aq data hash."""
    from protocol.term_table import render_table

    rows: list[tuple[str, Any]] = [
        ("hash", body.get("hash")),
        ("path", body.get("path")),
        ("kind", body.get("kind")),
        ("format", body.get("format")),
        ("bytes", body.get("bytes")),
        ("files", body.get("files")),
        ("n", body.get("n")),
        ("n_columns", body.get("n_columns")),
        ("target", body.get("target")),
        ("n_classes", body.get("n_classes")),
        ("snapshot", body.get("snapshot")),
        ("tokenizer", body.get("tokenizer")),
        ("at", body.get("at")),
    ]
    kv = [(k, v) for k, v in rows if v is not None and v != ""]
    lines = ["data", render_table(("key", "value"), kv)]
    cols = body.get("columns")
    if isinstance(cols, list) and cols:
        show = cols if len(cols) <= 24 else cols[:24] + [f"… +{len(cols) - 24}"]
        lines.append(render_table(("columns",), [[", ".join(str(c) for c in show)]]))
    classes = body.get("classes")
    if isinstance(classes, list) and classes:
        show = classes if len(classes) <= 16 else classes[:16] + [f"… +{len(classes) - 16}"]
        lines.append(render_table(("classes",), [[", ".join(str(c) for c in show)]]))
    if body.get("inspect_error"):
        lines.append(render_table(("key", "value"), [("inspect_error", body["inspect_error"])]))
    lines.append("file")
    lines.append("  data/revision.json")
    return lines


def hash_train(train: Path, snapshot: bool = False) -> list[str]:
    body = build_revision(train, snapshot=snapshot, write=True)
    return format_revision_lines(body)
