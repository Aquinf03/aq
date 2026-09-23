"""Public tracking API — autolog hooks + params / metrics / tags / notes.

    from aquin import autolog, log_params, log_metrics, set_tags, set_notes

    autolog(train=".")                 # hooks + metrics session
    log_params({"lr": 1e-3, "batch": 32})
    log_metrics({"loss": 0.4, "acc": 0.9}, step=10)
    set_tags("baseline", "gpu")
    set_notes("tried lower LR after spike")
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
    from protocol import runlog

    return integrations, aq_metrics, proto_autolog, runlog


def _ensure_session(train: str | Path | None = None) -> Path | None:
    """Begin a metrics session on a run folder if none is active."""
    _, aq_metrics, _, _ = _kernel()
    if aq_metrics.active_run_id() is not None:
        t = None
        try:
            t = aq_metrics._state.get("train")  # type: ignore[attr-defined]
        except Exception:
            pass
        return Path(t) if t else None

    root: Path | None = None
    if train is not None:
        root = open_run(train).root
    else:
        cwd = Path.cwd()
        if (cwd / "recipe.yaml").is_file():
            root = cwd.resolve()
    if root is None:
        return None
    try:
        from aquin.recipe_io import load_recipe_dict

        rec = load_recipe_dict(root / "recipe.yaml") if (root / "recipe.yaml").is_file() else {}
    except Exception:
        rec = {}
    aq_metrics.begin(root, op="log", recipe=rec if isinstance(rec, dict) else {})
    return root


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
    integrations, aq_metrics, proto_autolog, _runlog = _kernel()
    if disable:
        integrations.disable(frameworks or None)
        return []

    names = list(frameworks) if frameworks else None
    hooked = integrations.install(names)
    _ensure_session(train)
    return hooked


def disable(*frameworks: str) -> None:
    """Remove framework hooks."""
    autolog(*frameworks, disable=True)


def frameworks() -> dict[str, Any]:
    """Catalog of adapters / aliases / currently active hooks."""
    integrations, _, _, _ = _kernel()
    return integrations.catalog()


def log_params(params: dict[str, Any], *, train: str | Path | None = None) -> None:
    """Log hyperparameters (dict). Same idea as wandb.config / mlflow.log_params."""
    _, _, _, runlog = _kernel()
    _ensure_session(train)
    runlog.log_params(params)


def log_metric(
    key: str,
    value: float | int,
    *,
    step: int | None = None,
    train: str | Path | None = None,
) -> None:
    """Log one scalar metric."""
    log_metrics({key: value}, step=step, train=train)


def log_metrics(
    metrics: dict[str, Any],
    *,
    step: int | None = None,
    train: str | Path | None = None,
) -> None:
    """Log several scalars. ``loss`` becomes a step event when step/loss present."""
    _, _, _, runlog = _kernel()
    _ensure_session(train)
    runlog.log_metrics(metrics, step=step)


def set_tags(
    *tags: str,
    replace: bool = False,
    train: str | Path | None = None,
) -> list[str]:
    """Tag the active run (searchable labels on runs/<id>.json)."""
    _, _, _, runlog = _kernel()
    _ensure_session(train)
    return runlog.set_tags(*tags, replace=replace)


def add_tags(*tags: str, train: str | Path | None = None) -> list[str]:
    return set_tags(*tags, replace=False, train=train)


def clear_tags(*, train: str | Path | None = None) -> None:
    _, _, _, runlog = _kernel()
    _ensure_session(train)
    runlog.clear_tags()


def get_tags() -> list[str]:
    _, _, _, runlog = _kernel()
    return runlog.get_tags()


def set_notes(text: str | None, *, train: str | Path | None = None) -> str:
    """Free-text notes on the active run."""
    _, _, _, runlog = _kernel()
    _ensure_session(train)
    return runlog.set_notes(text)


def get_notes() -> str | None:
    _, _, _, runlog = _kernel()
    return runlog.get_notes()


def log_artifact(key: str, path: str | Path, *, train: str | Path | None = None) -> None:
    _, _, proto_autolog, _ = _kernel()
    _ensure_session(train)
    proto_autolog.log_artifact(key, path)


def finish(**meta: Any) -> dict[str, str]:
    """End a metrics session started by autolog/log_*."""
    _, aq_metrics, _, _ = _kernel()
    return aq_metrics.end(**meta)


# Aliases ML engs often type
log_param = log_params  # wandb-style singular often used for one dict too
