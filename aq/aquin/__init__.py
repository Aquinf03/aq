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
from aquin.flow import Flow, Run, retry, step
from aquin.flow_store import FlowArtifacts, open_flow_artifacts
from aquin.handle import RunHandle, open_run
from aquin.catalog import (
    alias,
    aliases,
    artifact,
    artifacts,
    promote,
    rebuild_catalog,
)
from aquin.lineage import lineage
from aquin.model import Model, load
from aquin.scaffold import init_run

try:
    from aquin.fleet import Job, Place, Queue
except ImportError:  # thin checkouts without fleet
    Job = Place = Queue = None  # type: ignore[misc, assignment]

__all__ = [
    "Aquin",
    "Flow",
    "FlowArtifacts",
    "Job",
    "Model",
    "Place",
    "Queue",
    "Run",
    "RunHandle",
    "add_tags",
    "alias",
    "aliases",
    "artifact",
    "artifacts",
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
    "lineage",
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
    "open_flow_artifacts",
    "open_run",
    "promote",
    "rebuild_catalog",
    "retry",
    "set_notes",
    "set_tags",
    "start_system",
    "step",
    "stop_system",
    "table",
]
__version__ = "0.1.0"
