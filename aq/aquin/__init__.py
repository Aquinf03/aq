"""Aquin SDK — few lines; Python authors, recipe.yaml is the path map, artifacts/ is runtime."""

from __future__ import annotations

from aquin.autolog import (
    add_tags,
    autolog,
    clear_tags,
    disable as disable_autolog,
    disable_grads,
    enable_grads,
    evaluate,
    finish,
    finish_autolog,
    frameworks,
    get_notes,
    get_tags,
    log_artifact,
    log_grads,
    log_infra,
    log_metric,
    log_metrics,
    log_model,
    log_param,
    log_params,
    log_system,
    set_notes,
    set_tags,
    start_system,
    stop_system,
    table,
)
from aquin.client import Aquin
try:
    from aquin.fleet import Job, Place, Queue
except ImportError:  # thin checkouts without fleet
    Job = Place = Queue = None  # type: ignore[misc, assignment]
from aquin.flow import Run
from aquin.handle import RunHandle, open_run
from aquin.model import Model, load
from aquin.scaffold import init_run

__all__ = [
    "Aquin",
    "Model",
    "Job",
    "Place",
    "Queue",
    "Run",
    "RunHandle",
    "add_tags",
    "autolog",
    "clear_tags",
    "disable_autolog",
    "disable_grads",
    "enable_grads",
    "evaluate",
    "finish",
    "finish_autolog",
    "frameworks",
    "get_notes",
    "get_tags",
    "init_run",
    "load",
    "log_artifact",
    "log_grads",
    "log_infra",
    "log_metric",
    "log_metrics",
    "log_model",
    "log_param",
    "log_params",
    "log_system",
    "open_run",
    "set_notes",
    "set_tags",
    "start_system",
    "stop_system",
    "table",
]
__version__ = "0.1.0"
