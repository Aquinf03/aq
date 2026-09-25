"""Aquin SDK — few lines; Python authors, recipe.yaml is the path map, artifacts/ is runtime."""

from __future__ import annotations

from aquin.autolog import (
    add_tags,
    autolog,
    clear_tags,
    disable as disable_autolog,
    disable_grads,
    enable_grads,
    finish,
    finish_autolog,
    frameworks,
    get_notes,
    get_tags,
    log_artifact,
    log_grads,
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
)
from aquin.client import Aquin
from aquin.fleet import Job, Place, Queue
from aquin.flow import Run
from aquin.handle import RunHandle, open_run
from aquin.scaffold import init_run

__all__ = [
    "Aquin",
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
    "finish",
    "finish_autolog",
    "frameworks",
    "get_notes",
    "get_tags",
    "init_run",
    "log_artifact",
    "log_grads",
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
]
__version__ = "0.1.0"
