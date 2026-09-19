"""Layout paths from recipe.yaml — defaults match the classic tree.

    paths:
      artifacts: artifacts   # runtime root (checkpoints, metrics, plots, …)
      evals: evals           # probe set directory

Relative paths are under the train root. Absolute paths are allowed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

DEFAULTS: dict[str, str] = {
    "artifacts": "artifacts",
    "evals": "evals",
}


def peek_recipe(train: Path) -> dict[str, Any]:
    """Load recipe.yaml without full validation (for path resolution)."""
    recipe = train / "recipe.yaml"
    if not recipe.is_file():
        return {}
    try:
        from protocol.recipe import parse_recipe

        return parse_recipe(recipe)
    except Exception:
        return {}


def path_map(rec: dict[str, Any] | None) -> dict[str, str]:
    """Resolved path map (defaults filled in)."""
    out = dict(DEFAULTS)
    raw = (rec or {}).get("paths") if isinstance(rec, dict) else None
    if isinstance(raw, dict):
        for key in DEFAULTS:
            val = raw.get(key)
            if val is None or val is False:
                continue
            s = str(val).strip()
            if s:
                out[key] = s
    return out


def rel(rec: dict[str, Any] | None, key: str) -> str:
    if key not in DEFAULTS:
        raise KeyError(key)
    return path_map(rec)[key]


def resolve(train: Path, rel_or_abs: str) -> Path:
    p = Path(rel_or_abs).expanduser()
    if p.is_absolute():
        return p.resolve()
    return (train / p).resolve()


def art_dir(train: Path, rec: dict[str, Any] | None = None) -> Path:
    if rec is None:
        rec = peek_recipe(train)
    return resolve(train, rel(rec, "artifacts"))


def evals_dir(train: Path, rec: dict[str, Any] | None = None) -> Path:
    if rec is None:
        rec = peek_recipe(train)
    return resolve(train, rel(rec, "evals"))


def ckpt_dir(train: Path, rec: dict[str, Any] | None = None) -> Path:
    d = art_dir(train, rec) / "checkpoints"
    d.mkdir(parents=True, exist_ok=True)
    return d
