"""Dataset ↔ task ↔ model lineage."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aquin.bridge import _ensure_kernel_path
from aquin.handle import find_kernel, open_run


def _find_train(train: str | Path | None) -> Path:
    if train is not None:
        return open_run(train).root
    here = Path.cwd().resolve()
    for p in [here, *here.parents]:
        if (p / "recipe.yaml").is_file():
            return p
        if len(p.parts) <= 2:
            break
    return here


def lineage(
    ref: str | Path = "last",
    *,
    train: str | Path | None = None,
) -> dict[str, Any]:
    """Who trained these weights: model → task → run → data revision.

    ``ref``: ``last``, checkpoint path/step, ``aq_model_id`` (``sha256:…``), or run id.
    Returns ``model`` / ``task`` / ``run`` / ``data`` (dataset version + optional name).
    """
    kernel = find_kernel()
    _ensure_kernel_path(kernel)
    from protocol.lineage import resolve_lineage

    return resolve_lineage(_find_train(train), ref)
