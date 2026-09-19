#!/usr/bin/env python3
"""Hash the data the recipe points at. Optional snapshot under data/revisions/."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

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


def hash_train(train: Path, snapshot: bool = False) -> list[str]:
    rec = load_recipe(train)
    rel = str((rec.get("data") or {}).get("path"))
    src = (train / rel).resolve()
    if not src.exists():
        raise SystemExit(f"data path not found: {rel}")
    digest, nbytes, nfiles = hash_tree(src)
    hid = "sha256:" + digest
    snap_rel = None
    if snapshot:
        snap_rel = f"data/revisions/{digest}"
        snapshot_copy(src, train / snap_rel)
    data_dir = train / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    rec = {
        "path": rel,
        "hash": hid,
        "bytes": nbytes,
        "files": nfiles,
        "snapshot": snap_rel,
    }
    tok = art_dir(train) /  "tokenizer.json"
    if tok.is_file():
        td, _ = hash_file(tok)
        rec["tokenizer"] = "sha256:" + td
        rec["tokenizer_path"] = "artifacts/tokenizer.json"
    (data_dir / "revision.json").write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    lines = ["hash", "  " + hid, "  " + rel]
    if snap_rel:
        lines.append("  " + snap_rel)
    if tok.is_file():
        lines.append("  tokenizer sha256:" + rec["tokenizer"].split(":", 1)[-1])
        lines.append("  artifacts/tokenizer.json")
    return lines
