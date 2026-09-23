"""Aquin SDK — few lines; Python authors, recipe.yaml is the path map, artifacts/ is runtime."""

from __future__ import annotations

from aquin.autolog import (
    add_tags,
    autolog,
    clear_tags,
    disable as disable_autolog,
    finish as finish_autolog,
    frameworks,
    get_notes,
    get_tags,
    log_artifact,
    log_metric,
    log_metrics,
    log_params,
    set_notes,
    set_tags,
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
    "finish_autolog",
    "frameworks",
    "get_notes",
    "get_tags",
    "init_run",
    "log_artifact",
    "log_metric",
    "log_metrics",
    "log_params",
    "open_run",
    "set_notes",
    "set_tags",
]
__version__ = "0.1.0"
