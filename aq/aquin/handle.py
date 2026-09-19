"""Run identity: YAML config + artifacts folder (layout from recipe paths:)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RunHandle:
    root: Path
    config_path: Path
    artifacts_dir: Path


def _artifacts_from_recipe(root: Path, config_path: Path) -> Path:
    """Prefer recipe paths.artifacts; fall back to <root>/artifacts."""
    try:
        from aquin.recipe_io import load_recipe_dict

        if config_path.is_file():
            rec = load_recipe_dict(config_path)
        else:
            rec = {}
        raw = rec.get("paths") if isinstance(rec, dict) else None
        rel = None
        if isinstance(raw, dict) and raw.get("artifacts"):
            rel = str(raw["artifacts"]).strip()
        if rel:
            p = Path(rel).expanduser()
            return p.resolve() if p.is_absolute() else (root / p).resolve()
    except Exception:
        pass
    return (root / "artifacts").resolve()


def open_run(config_or_dir: str | Path, artifacts: str | Path | None = None) -> RunHandle:
    """Open a run from recipe.yaml or a directory containing it."""
    resolved = Path(config_or_dir).expanduser().resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"not found: {resolved}")

    if resolved.is_dir():
        root = resolved
        config_path = root / "recipe.yaml"
        if not config_path.is_file():
            raise FileNotFoundError(f"not a run (need recipe.yaml): {root}")
    else:
        config_path = resolved
        root = config_path.parent

    if artifacts is not None:
        artifacts_dir = Path(artifacts).expanduser().resolve()
    else:
        artifacts_dir = _artifacts_from_recipe(root, config_path)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    return RunHandle(root=root, config_path=config_path, artifacts_dir=artifacts_dir)


def find_kernel() -> Path:
    """Locate aq/kernel (run.py). Honors AQ_KERNEL / AQUIN_KERNEL."""
    for key in ("AQ_KERNEL", "AQUIN_KERNEL"):
        env = os.environ.get(key)
        if env:
            p = Path(env).expanduser().resolve()
            if (p / "run.py").is_file():
                return p
            raise FileNotFoundError(f"{key}={p} has no run.py")

    here = Path(__file__).resolve()
    # Prefer aq/kernel when installed from aq/aquin (sibling of aquin package).
    candidates: list[Path] = [here.parents[1] / "kernel"]
    for parent in [here.parent, *here.parents]:
        candidates.append(parent / "aq" / "kernel")
        candidates.append(parent / "kernel")

    seen: set[Path] = set()
    for c in candidates:
        try:
            c = c.resolve()
        except OSError:
            continue
        if c in seen:
            continue
        seen.add(c)
        if (c / "run.py").is_file():
            return c

    raise FileNotFoundError(
        "aq kernel not found (set AQ_KERNEL to aq/kernel, or install from aqfw checkout)"
    )
