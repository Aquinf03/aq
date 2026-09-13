"""Minimal recipe writer matching aq/kernel/protocol/recipe.parse_recipe (2-level)."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _fmt(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def dump_recipe(data: dict[str, Any], path: str | Path) -> Path:
    """Write a recipe.yaml the kernel can parse. Nested dicts = one section level only."""
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for key, val in data.items():
        if isinstance(val, dict):
            lines.append(f"{key}:")
            for sk, sv in val.items():
                if isinstance(sv, dict):
                    raise ValueError(
                        f"recipe key {key}.{sk} is nested too deep for kernel parser (max 2 levels)"
                    )
                lines.append(f"  {sk}: {_fmt(sv)}")
        else:
            lines.append(f"{key}: {_fmt(val)}")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dest
