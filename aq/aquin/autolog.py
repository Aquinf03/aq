"""Public tracking API — few-line W&B / MLflow-shaped surface.

    from aquin import autolog, log_params, log_metric, set_tags, finish

    autolog(train=".")                 # hooks + metrics session
    log_params({"lr": 1e-3, "batch": 32})
    log_metric("loss", 0.4, step=10)
    set_tags("baseline", "gpu")
    finish()                           # writes runs/<id>.json
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


def log_param(
    key: str | dict[str, Any],
    value: Any = None,
    *,
    train: str | Path | None = None,
) -> None:
    """Log one param (``log_param("lr", 1e-3)``) or a dict (``log_param({"lr": 1e-3})``)."""
    if isinstance(key, dict):
        log_params(key, train=train)
        return
    if value is None:
        raise TypeError('log_param("key", value) needs a value (or pass a dict)')
    log_params({str(key): value}, train=train)


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


def log_model(
    checkpoint: str | Path | None = None,
    *,
    train: str | Path | None = None,
    data_hash: str | None = None,
) -> str | None:
    """Bind a checkpoint as the logged model for this run (stable id + dataset link).

    If ``checkpoint`` is omitted, uses ``artifacts/checkpoints/last.json`` under the
    active train folder. Returns the content-addressed ``logged_model`` id.
    """
    from protocol.model_log import id_from_checkpoint
    from protocol.paths import ckpt_dir
    from protocol.record import data_hash as record_data_hash
    from protocol.recipe import load_recipe

    _, aq_metrics, proto_autolog, _ = _kernel()
    root = _ensure_session(train)
    if root is None:
        return None
    if checkpoint is None:
        ckpt = ckpt_dir(root) / "last.json"
        ckpt_rel = "artifacts/checkpoints/last.json"
    else:
        p = Path(checkpoint)
        if not p.is_absolute():
            p = (root / p).resolve()
        ckpt = p
        try:
            ckpt_rel = str(ckpt.relative_to(root))
        except ValueError:
            ckpt_rel = str(checkpoint)
    mid = id_from_checkpoint(ckpt)
    if not mid:
        return None
    dh = data_hash
    if dh is None:
        try:
            rec = load_recipe(root)
            dh = record_data_hash(root, rec)
        except Exception:
            dh = None
    aq_metrics.bind_model(logged_model=mid, checkpoint=ckpt_rel, data_hash=dh)
    aq_metrics.event("model", id=mid, checkpoint=ckpt_rel, data_hash=dh)
    proto_autolog.log_artifact("logged_model", mid)
    proto_autolog.log_artifact("checkpoint", ckpt_rel)
    return mid


def finish(**meta: Any) -> dict[str, str]:
    """End a metrics session started by autolog/log_*.

    For standalone SDK sessions (``op=log``), also writes ``artifacts/runs/<id>.json``.
    ``aq train`` already persists the run after ``end`` — no double write.
    """
    from protocol.record import write_run

    _, aq_metrics, _, _ = _kernel()
    train = None
    op = None
    try:
        train = aq_metrics._state.get("train")  # type: ignore[attr-defined]
        op = aq_metrics._state.get("op")  # type: ignore[attr-defined]
    except Exception:
        pass
    arts = aq_metrics.end(**meta)
    if train is not None and op == "log":
        extra_arts = dict(arts)
        extra_arts.setdefault("metrics", "artifacts/metrics.jsonl")
        write_run(Path(train), {"artifacts": extra_arts})
    return arts


# Aliases ML engs often type
finish_autolog = finish

