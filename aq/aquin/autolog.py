"""Public autolog API — enable framework hooks; optional metrics session for standalone scripts.

    from aquin import autolog
    autolog()                    # all importable integrations
    autolog("sklearn", "xgboost")

    # Standalone script (no aq train): also starts a metrics session on the run folder
    autolog(train=".")

Writes into the same folder-first store as aq train (artifacts/metrics.jsonl).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aquin.bridge import _ensure_kernel_path
from aquin.handle import find_kernel, open_run


def _kernel():
    kernel = find_kernel()
    _ensure_kernel_path(kernel)
    from protocol import integrations
    from protocol import metrics as aq_metrics
    from protocol import autolog as proto_autolog

    return integrations, aq_metrics, proto_autolog


def autolog(
    *frameworks: str,
    train: str | Path | None = None,
    disable: bool = False,
) -> list[str]:
    """
    Turn on (or off) framework integrations.

    Args:
        *frameworks: e.g. "sklearn", "transformers", "xgboost". Empty = all available.
        train: run directory or recipe.yaml — if set (or cwd is a run), begin a metrics
               session so hooks have somewhere to write outside ``aq train``.
        disable: uninstall hooks instead.
    """
    integrations, aq_metrics, proto_autolog = _kernel()
    if disable:
        integrations.disable(frameworks or None)
        return []

    names = list(frameworks) if frameworks else None
    hooked = integrations.install(names)

    root: Path | None = None
    if train is not None:
        root = open_run(train).root
    else:
        cwd = Path.cwd()
        if (cwd / "recipe.yaml").is_file():
            root = cwd.resolve()

    if root is not None and aq_metrics.active_run_id() is None:
        try:
            from aquin.recipe_io import load_recipe_dict

            rec = load_recipe_dict(root / "recipe.yaml") if (root / "recipe.yaml").is_file() else {}
        except Exception:
            rec = {}
        aq_metrics.begin(root, op="autolog", recipe=rec if isinstance(rec, dict) else {})

    return hooked


def disable(*frameworks: str) -> None:
    """Remove framework hooks."""
    autolog(*frameworks, disable=True)


def frameworks() -> dict[str, Any]:
    """Catalog of adapters / aliases / currently active hooks."""
    integrations, _, _ = _kernel()
    return integrations.catalog()


def log_params(params: dict[str, Any]) -> None:
    _, _, proto_autolog = _kernel()
    proto_autolog.log_params(params)


def log_metric(key: str, value: float, *, step: int | None = None) -> None:
    _, aq_metrics, _ = _kernel()
    if key in ("loss", "train_loss"):
        aq_metrics.step(step=step, loss=float(value))
    else:
        fields = {key: float(value)}
        if step is not None:
            aq_metrics.step(step=step, **fields)
        else:
            aq_metrics.event("metric", **fields)


def log_artifact(key: str, path: str | Path) -> None:
    _, _, proto_autolog = _kernel()
    proto_autolog.log_artifact(key, path)


def finish(**meta: Any) -> dict[str, str]:
    """End a metrics session started by autolog(train=...)."""
    _, aq_metrics, _ = _kernel()
    return aq_metrics.end(**meta)
