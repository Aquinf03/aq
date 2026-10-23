"""Dataset revisions — immutable manifests under ``data/revisions/``."""

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


def _proto():
    kernel = find_kernel()
    _ensure_kernel_path(kernel)
    from protocol import revision as rev

    return rev


def hash_data(
    train: str | Path | None = None,
    *,
    snapshot: bool = False,
) -> dict[str, Any]:
    """Hash recipe ``data.path`` → tip + immutable revision manifest."""
    return _proto().build_revision(_find_train(train), snapshot=snapshot, write=True)


def list_datasets(train: str | Path | None = None) -> list[dict[str, Any]]:
    """List ``data/revisions/<hex>.json`` manifests (dataset versions)."""
    return _proto().list_manifests(_find_train(train))


def show_dataset(
    ref: str = "last",
    *,
    train: str | Path | None = None,
) -> dict[str, Any]:
    """Show tip / ``sha256:…`` / digest prefix / revision path."""
    body = _proto().load_manifest(_find_train(train), ref)
    if body is None:
        raise FileNotFoundError(f"no data revision for {ref!r}")
    return body
