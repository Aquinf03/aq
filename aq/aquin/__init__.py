"""Aquin SDK — few lines; Python authors, recipe.yaml is the path map, artifacts/ is runtime."""

from __future__ import annotations

from aquin.autolog import autolog, disable as disable_autolog, finish as finish_autolog, frameworks, log_artifact, log_metric, log_params
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
    "autolog",
    "disable_autolog",
    "finish_autolog",
    "frameworks",
    "init_run",
    "log_artifact",
    "log_metric",
    "log_params",
    "open_run",
]
__version__ = "0.1.0"
