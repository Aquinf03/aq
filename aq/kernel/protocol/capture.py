"""Opt-in capture — code tree + env (no git).

Off unless enabled:

  capture:
    code: true
    env: lock          # pip freeze (light) | full (7z of the active venv)

  aq train --capture-code
  aq train --capture-env          # lock
  aq train --capture-env=full     # 7z prefix
  AQ_CAPTURE_CODE=1 / AQ_CAPTURE_ENV=lock|full|1

artifacts/code/   tree.tgz + manifest.json
artifacts/env/    requirements.txt + python.json
                env.7z when mode=full (needs 7z/7zz on PATH)
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.paths import art_dir

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

# Inside a venv archive — skip junk that bloats without helping replay.
# (7z -x patterns handle __pycache__ / *.pyc)

_last_code: dict[str, Any] | None = None
_last_env: dict[str, Any] | None = None


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "on", "1", "code")


def _env_mode(v: Any) -> str | None:
    """Return 'lock', 'full', or None."""
    if v is None or v is False:
        return None
    if v is True:
        return "lock"
    s = str(v).strip().lower()
    if s in ("0", "false", "no", "off", ""):
        return None
    if s in ("1", "true", "yes", "on", "lock", "freeze", "pip"):
        return "lock"
    if s in ("full", "7z", "venv", "prefix"):
        return "full"
    return "lock"


def parse_capture(rec: dict) -> dict[str, Any]:
    raw = rec.get("capture")
    if raw is True or (_truthy(raw) and not isinstance(raw, dict)):
        return {"code": True, "env": None}
    if not isinstance(raw, dict):
        return {"code": False, "env": None}
    return {
        "code": _truthy(raw.get("code")),
        "env": _env_mode(raw.get("env")),
    }


def want_code(rec: dict, req: dict | None = None) -> bool:
    if req and _truthy(req.get("capture_code")):
        return True
    env = os.environ.get("AQ_CAPTURE_CODE", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    return bool(parse_capture(rec).get("code"))


def want_env(rec: dict, req: dict | None = None) -> str | None:
    """Which env mode to run, if any."""
    if req:
        if "capture_env" in req and req.get("capture_env") is not None:
            return _env_mode(req.get("capture_env"))
    env = os.environ.get("AQ_CAPTURE_ENV", "").strip()
    if env:
        return _env_mode(env)
    return parse_capture(rec).get("env")


def take_code_meta() -> dict[str, Any] | None:
    global _last_code
    out = _last_code
    _last_code = None
    return out


def take_env_meta() -> dict[str, Any] | None:
    global _last_env
    out = _last_env
    _last_env = None
    return out


def maybe_snapshot(train: Path, rec: dict, req: dict | None = None) -> dict[str, Any] | None:
    """Back-compat: code snapshot only."""
    if not want_code(rec, req):
        return None
    return snapshot_code(train, rec)


def maybe_capture(
    train: Path, rec: dict, req: dict | None = None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Run enabled capture modes. Returns (code_meta, env_meta)."""
    code_meta = snapshot_code(train, rec) if want_code(rec, req) else None
    mode = want_env(rec, req)
    env_meta = snapshot_env(train, rec, mode=mode) if mode else None
    return code_meta, env_meta


def snapshot_code(train: Path, rec: dict | None = None) -> dict[str, Any]:
    global _last_code
    train = Path(train).resolve()
    dest = art_dir(train, rec) / "code"
    dest.mkdir(parents=True, exist_ok=True)
    tree_path = dest / "tree.tgz"
    manifest_path = dest / "manifest.json"

    entries: list[tuple[str, Path]] = []
    _collect_train(train, entries)
    _collect_kernel(entries)
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
    tree_rel, manifest_rel = _rels(train, tree_path, manifest_path)
    body = {
        "at": _iso(),
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
    _last_code = meta
    return meta


def snapshot_env(
    train: Path, rec: dict | None = None, *, mode: str = "lock"
) -> dict[str, Any]:
    """Write artifacts/env/. mode=lock → freeze; mode=full → freeze + 7z venv."""
    global _last_env
    train = Path(train).resolve()
    dest = art_dir(train, rec) / "env"
    dest.mkdir(parents=True, exist_ok=True)

    req_path = dest / "requirements.txt"
    py_path = dest / "python.json"
    freeze = _pip_freeze()
    req_path.write_text(freeze, encoding="utf-8")

    prefix = _active_prefix()
    py_info = {
        "executable": sys.executable,
        "version": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "prefix": str(prefix) if prefix else None,
        "in_venv": bool(prefix and (prefix / "pyvenv.cfg").is_file()),
    }
    py_path.write_text(json.dumps(py_info, indent=2) + "\n", encoding="utf-8")

    # Optional local setup scripts (system deps hint — not executed here).
    setup_copied: list[str] = []
    for name in ("setup.sh", "env.sh", "bootstrap.sh"):
        src = train / name
        if src.is_file():
            out = dest / name
            shutil.copy2(src, out)
            setup_copied.append(_rel(train, out))

    meta: dict[str, Any] = {
        "mode": mode,
        "at": _iso(),
        "requirements": _rel(train, req_path),
        "python": _rel(train, py_path),
        "n_packages": sum(1 for line in freeze.splitlines() if line.strip() and not line.startswith("#")),
        "platform": py_info["platform"],
        "machine": py_info["machine"],
        "python_version": py_info["version"],
    }
    if setup_copied:
        meta["setup_scripts"] = setup_copied

    if mode == "full":
        archive = _archive_prefix_7z(train, dest, prefix)
        meta.update(archive)

    manifest_path = dest / "manifest.json"
    manifest_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    meta["manifest"] = _rel(train, manifest_path)
    _last_env = meta
    return meta


def _archive_prefix_7z(train: Path, dest: Path, prefix: Path | None) -> dict[str, Any]:
    if prefix is None or not prefix.is_dir():
        raise SystemExit(
            "capture.env: full needs an active venv (pyvenv.cfg). "
            "Use capture.env: lock, or train with aq/kernel/.venv."
        )
    seven = _find_7z()
    if seven:
        out = dest / "env.7z"
        tmp = dest / f".env.{os.getpid()}.7z"
        if tmp.exists():
            tmp.unlink()
        if out.exists():
            out.unlink()
        cmd = [
            seven,
            "a",
            "-t7z",
            "-mx=5",
            "-mmt=on",
            "-x!**/__pycache__",
            "-x!**/__pycache__/**",
            "-x!*.pyc",
            "-x!*.pyo",
            str(tmp),
            ".",
        ]
        r = subprocess.run(cmd, cwd=str(prefix), capture_output=True, text=True)
        if r.returncode != 0 or not tmp.is_file():
            err = (r.stderr or r.stdout or "").strip() or f"exit {r.returncode}"
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            raise SystemExit(f"7z env archive failed: {err}")
        tmp.replace(out)
        digest, nbytes = _hash_file(out)
        return {
            "archive": _rel(train, out),
            "archive_format": "7z",
            "sha256": "sha256:" + digest,
            "bytes": nbytes,
            "prefix_name": prefix.name,
            "source_prefix": str(prefix),
        }

    # Fallback when p7zip is not installed — still a full prefix snapshot.
    out = dest / "env.tar.xz"
    tmp = dest / f".env.{os.getpid()}.tar.xz"
    if tmp.exists():
        tmp.unlink()
    if out.exists():
        out.unlink()
    with tarfile.open(tmp, "w:xz") as tar:
        for f in sorted(prefix.rglob("*")):
            if not f.is_file():
                continue
            rel_parts = f.relative_to(prefix).parts
            if any(p == "__pycache__" for p in rel_parts):
                continue
            if f.suffix in {".pyc", ".pyo"}:
                continue
            tar.add(f, arcname=f.relative_to(prefix).as_posix(), recursive=False)
    tmp.replace(out)
    digest, nbytes = _hash_file(out)
    return {
        "archive": _rel(train, out),
        "archive_format": "tar.xz",
        "sha256": "sha256:" + digest,
        "bytes": nbytes,
        "prefix_name": prefix.name,
        "source_prefix": str(prefix),
        "note": "7z/7zz not on PATH; wrote tar.xz. Install p7zip for env.7z.",
    }


def _find_7z() -> str | None:
    for name in ("7zz", "7z", "7za"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _active_prefix() -> Path | None:
    """Prefer the venv that owns sys.executable; else kernel/.venv if present."""
    exe = Path(sys.executable).resolve()
    for parent in [exe.parent.parent, Path(sys.prefix)]:
        if (parent / "pyvenv.cfg").is_file():
            return parent.resolve()
    kernel_venv = Path(__file__).resolve().parent.parent / ".venv"
    if (kernel_venv / "pyvenv.cfg").is_file():
        return kernel_venv.resolve()
    return None


def _pip_freeze() -> str:
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "freeze"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout if r.stdout.endswith("\n") else r.stdout + "\n"
    except (OSError, subprocess.TimeoutExpired):
        pass
    # Fallback: importlib.metadata
    try:
        from importlib import metadata

        lines = []
        for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
            name = dist.metadata["Name"]
            ver = dist.version
            if name and ver:
                lines.append(f"{name}=={ver}")
        return "\n".join(lines) + ("\n" if lines else "")
    except Exception:
        return f"# freeze unavailable\n# python {sys.version}\n"


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


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _rel(train: Path, path: Path) -> str:
    try:
        return str(path.relative_to(train))
    except ValueError:
        return str(path)


def _rels(train: Path, *paths: Path) -> tuple[str, ...]:
    return tuple(_rel(train, p) for p in paths)
