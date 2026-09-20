"""Opt-in code-tree capture — freeze bytes that affected a run (no git).

Off unless the user enables it:

  capture:
    code: true

  # or: aq train --capture-code
  # or: AQ_CAPTURE_CODE=1

Writes under artifacts/code/:

  tree.tgz       train recipe/tools + kernel fit slices
  manifest.json  file list + sha256 of the archive

Run record gets a ``code`` block + artifact pointer. Worker replay = unpack the tarball.
"""

from __future__ import annotations

import hashlib
import json
import os
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.paths import art_dir

# Same slices as record.code_hash (what fit actually imports).
_KERNEL_SUBS = ("protocol", "backends", "methods", "engine")

_SKIP_DIR_NAMES = {
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "catboost_info",
    "artifacts",
}

_SKIP_FILE_SUFFIX = {".pyc", ".pyo", ".DS_Store"}

_last: dict[str, Any] | None = None


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "on", "1", "code")


def parse_capture(rec: dict) -> dict[str, bool]:
    raw = rec.get("capture")
    if raw is True or _truthy(raw) and not isinstance(raw, dict):
        return {"code": True}
    if not isinstance(raw, dict):
        return {"code": False}
    return {"code": _truthy(raw.get("code"))}


def want_code(rec: dict, req: dict | None = None) -> bool:
    """Recipe, request flag, or AQ_CAPTURE_CODE env."""
    if req and _truthy(req.get("capture_code")):
        return True
    env = os.environ.get("AQ_CAPTURE_CODE", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    return bool(parse_capture(rec).get("code"))


def take_code_meta() -> dict[str, Any] | None:
    """Consume the last snapshot for write_run."""
    global _last
    out = _last
    _last = None
    return out


def peek_code_meta() -> dict[str, Any] | None:
    return dict(_last) if _last else None


def snapshot_code(train: Path, rec: dict | None = None) -> dict[str, Any]:
    """Build artifacts/code/tree.tgz + manifest. Idempotent per call (overwrites)."""
    global _last
    train = Path(train).resolve()
    dest = art_dir(train, rec) / "code"
    dest.mkdir(parents=True, exist_ok=True)
    tree_path = dest / "tree.tgz"
    manifest_path = dest / "manifest.json"

    entries: list[tuple[str, Path]] = []
    _collect_train(train, entries)
    _collect_kernel(entries)

    # Stable order for reproducible archives.
    entries.sort(key=lambda x: x[0])

    tmp = dest / f".tree.{os.getpid()}.tgz"
    try:
        with tarfile.open(tmp, "w:gz") as tar:
            for arcname, path in entries:
                tar.add(path, arcname=arcname, recursive=False)
        tmp.replace(tree_path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass

    digest, nbytes = _hash_file(tree_path)
    files = [{"path": a, "bytes": p.stat().st_size} for a, p in entries]
    try:
        tree_rel = str(tree_path.relative_to(train))
        manifest_rel = str(manifest_path.relative_to(train))
    except ValueError:
        tree_rel = str(tree_path)
        manifest_rel = str(manifest_path)
    body = {
        "at": datetime.now(timezone.utc).isoformat(),
        "sha256": "sha256:" + digest,
        "bytes": nbytes,
        "n_files": len(files),
        "tree": tree_rel,
        "manifest": manifest_rel,
        "files": files,
    }
    manifest_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")

    meta = {
        "sha256": body["sha256"],
        "bytes": nbytes,
        "n_files": len(files),
        "tree": body["tree"],
        "manifest": body["manifest"],
        "at": body["at"],
    }
    _last = meta
    return meta


def maybe_snapshot(train: Path, rec: dict, req: dict | None = None) -> dict[str, Any] | None:
    if not want_code(rec, req):
        return None
    return snapshot_code(train, rec)


def _collect_train(train: Path, out: list[tuple[str, Path]]) -> None:
    for name in ("recipe.yaml", "example.py"):
        p = train / name
        if p.is_file():
            out.append((f"train/{name}", p))
    tools = train / "tools"
    if tools.is_dir():
        for f in sorted(tools.rglob("*")):
            if not f.is_file() or _skip_file(f):
                continue
            if any(part in _SKIP_DIR_NAMES for part in f.relative_to(tools).parts):
                continue
            rel = f.relative_to(train).as_posix()
            out.append((f"train/{rel}", f))
    # Extra top-level .py next to the recipe (custom hooks).
    for f in sorted(train.glob("*.py")):
        if f.name == "example.py":
            continue
        if f.is_file() and not _skip_file(f):
            out.append((f"train/{f.name}", f))


def _collect_kernel(out: list[tuple[str, Path]]) -> None:
    kernel_root = Path(__file__).resolve().parent.parent
    for sub in _KERNEL_SUBS:
        base = kernel_root / sub
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*.py")):
            if _skip_file(f):
                continue
            if any(part in _SKIP_DIR_NAMES for part in f.relative_to(base).parts):
                continue
            rel = f.relative_to(kernel_root).as_posix()
            out.append((f"kernel/{rel}", f))


def _skip_file(path: Path) -> bool:
    if path.name.startswith("."):
        return True
    if path.suffix in _SKIP_FILE_SUFFIX:
        return True
    return False


def _hash_file(path: Path) -> tuple[str, int]:
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
