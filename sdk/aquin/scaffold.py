"""Scaffold a run: recipe.yaml + example.py + artifacts/."""

from __future__ import annotations

from importlib import resources
from pathlib import Path


def _template(name: str) -> str:
    try:
        root = resources.files("aquin") / "templates"
        path = root / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
    except (TypeError, FileNotFoundError, OSError):
        pass

    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "aq" / "templates" / name
        if cand.is_file():
            return cand.read_text(encoding="utf-8")
    raise FileNotFoundError(f"template not found: {name}")


def init_run(dest: str | Path) -> tuple[Path, list[str], list[str]]:
    root = Path(dest).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    skipped: list[str] = []

    for name in ("recipe.yaml", "example.py"):
        path = root / name
        if path.exists():
            skipped.append(name)
            continue
        path.write_text(_template(name), encoding="utf-8")
        created.append(name)

    art = root / "artifacts"
    keep = art / ".gitkeep"
    if not art.exists():
        art.mkdir(parents=True)
        keep.write_text("", encoding="utf-8")
        created.append("artifacts/")
    else:
        skipped.append("artifacts/")

    return root, created, skipped
