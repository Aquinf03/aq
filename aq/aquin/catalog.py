"""Artifact catalog — content-addressed entries, aliases, promote, webhooks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aquin.bridge import _ensure_kernel_path
from aquin.handle import find_kernel, open_run


def _train(train: str | Path | None) -> Path:
    if train is not None:
        return open_run(train).root
    here = Path.cwd().resolve()
    for p in [here, *here.parents]:
        if (p / "recipe.yaml").is_file():
            return p
        if len(p.parts) <= 2:
            break
    return here


def _kernel():
    kernel = find_kernel()
    _ensure_kernel_path(kernel)
    from protocol import catalog as cat

    return cat


def artifacts(
    *,
    kind: str | None = None,
    limit: int | None = None,
    train: str | Path | None = None,
) -> list[dict[str, Any]]:
    """List catalog entries (newest first)."""
    return _kernel().list_entries(_train(train), kind=kind, limit=limit)


def artifact(ref: str = "last", *, train: str | Path | None = None) -> dict[str, Any] | None:
    """Get one entry by id / alias / last."""
    return _kernel().resolve_ref(_train(train), ref)


def aliases(*, train: str | Path | None = None) -> dict[str, Any]:
    """Alias name → {id, at, kind, by}."""
    return _kernel().load_aliases(_train(train))


def alias(
    name: str,
    ref: str = "last",
    *,
    train: str | Path | None = None,
) -> dict[str, Any]:
    """Point ``name`` at an artifact (``latest`` / ``best`` / custom)."""
    cat = _kernel()
    root = _train(train)
    entry = cat.resolve_ref(root, ref)
    if entry is None:
        raise FileNotFoundError(f"no artifact for {ref!r}")
    return cat.set_alias(root, name, str(entry["id"]), kind=entry.get("kind"))


def promote(
    name: str = "prod",
    ref: str = "last",
    *,
    train: str | Path | None = None,
    require_pass: bool | None = None,
) -> dict[str, Any]:
    """CI/CD handoff: set alias + fire promote webhooks."""
    return _kernel().promote(_train(train), name, ref, require_pass=require_pass)


def rebuild_catalog(*, train: str | Path | None = None) -> dict[str, int]:
    """Index existing runs into the catalog."""
    return _kernel().rebuild(_train(train))
