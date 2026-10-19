"""Code package snapshot for a Flow run — tarball of FlowSpec + aquin runtime.

Lands at ``artifacts/flow/<Name>/<run_id>/code/tree.tgz`` (+ ``manifest.json``).
Accessible as ``flow.code`` after ``run()``.
"""

from __future__ import annotations

import hashlib
import json
import os
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SKIP_DIRS = {
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".git",
    "artifacts",
    "evals",
    "jobs",
    "dist",
    "egg-info",
}

_SKIP_SUFFIX = {".pyc", ".pyo", ".DS_Store"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _should_skip_dir(name: str) -> bool:
    return name in _SKIP_DIRS or name.endswith(".egg-info")


def _collect_train_py(train: Path, entries: list[tuple[str, Path]], *, max_files: int = 400) -> None:
    """Shallow-ish collect of train-folder Python (the FlowSpec neighborhood)."""
    train = train.resolve()
    n = 0
    for dirpath, dirnames, filenames in os.walk(train):
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        base = Path(dirpath)
        for name in filenames:
            if n >= max_files:
                return
            suf = Path(name).suffix
            if suf not in {".py", ".yaml", ".yml", ".toml", ".txt", ".md"}:
                continue
            if name in _SKIP_SUFFIX or suf in _SKIP_SUFFIX:
                continue
            p = base / name
            if not p.is_file():
                continue
            try:
                rel = p.relative_to(train)
            except ValueError:
                continue
            # skip nested huge trees
            if len(rel.parts) > 4:
                continue
            entries.append((f"train/{rel.as_posix()}", p))
            n += 1


def _collect_aquin(entries: list[tuple[str, Path]]) -> None:
    """Bundle the aquin Flow runtime (workflow platform lib analogue)."""
    pkg = Path(__file__).resolve().parent
    for p in sorted(pkg.rglob("*.py")):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        try:
            rel = p.relative_to(pkg.parent)
        except ValueError:
            continue
        entries.append((rel.as_posix(), p))


def snapshot_flow_code(
    train: Path,
    run_root: Path,
    *,
    flow_file: Path | None = None,
    flow_name: str = "Flow",
) -> dict[str, Any]:
    """Write ``code/tree.tgz`` + ``manifest.json`` under the flow run dir."""
    train = train.resolve()
    run_root = run_root.resolve()
    dest = run_root / "code"
    dest.mkdir(parents=True, exist_ok=True)
    tree_path = dest / "tree.tgz"
    manifest_path = dest / "manifest.json"

    entries: list[tuple[str, Path]] = []
    # always include copied flow source if present
    for name in ("flow_src.py", "origin.json"):
        p = run_root / name
        if p.is_file():
            entries.append((f"flow/{name}", p))
    if flow_file is not None and flow_file.is_file():
        # original path copy under flow/
        entries.append((f"flow/source{flow_file.suffix}", flow_file))

    _collect_train_py(train, entries)
    _collect_aquin(entries)

    # dedupe by arcname
    seen: set[str] = set()
    uniq: list[tuple[str, Path]] = []
    for arc, path in entries:
        if arc in seen:
            continue
        seen.add(arc)
        uniq.append((arc, path))
    uniq.sort(key=lambda x: x[0])

    tmp = dest / f".tree.{os.getpid()}.tgz"
    try:
        with tarfile.open(tmp, "w:gz") as tar:
            for arcname, path in uniq:
                tar.add(path, arcname=arcname, recursive=False)
        tmp.replace(tree_path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass

    digest, nbytes = _hash_file(tree_path)
    files = [{"path": a, "bytes": p.stat().st_size} for a, p in uniq]
    body = {
        "at": _now(),
        "flow": flow_name,
        "sha256": "sha256:" + digest,
        "bytes": nbytes,
        "n_files": len(files),
        "tree": "code/tree.tgz",
        "manifest": "code/manifest.json",
        "files": files,
    }
    manifest_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return {
        "sha256": body["sha256"],
        "bytes": nbytes,
        "n_files": len(files),
        "tree": str(tree_path),
        "manifest": str(manifest_path),
        "rel_tree": "code/tree.tgz",
        "rel_manifest": "code/manifest.json",
        "at": body["at"],
        "flow": flow_name,
    }


def read_flow_code(run_root: Path) -> dict[str, Any] | None:
    """Load ``code/manifest.json`` if present."""
    p = run_root / "code" / "manifest.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    data = dict(data)
    data["tree"] = str(run_root / "code" / "tree.tgz")
    data["manifest"] = str(p)
    return data
