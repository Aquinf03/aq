"""Merge plot config: recipe.yaml plot:, ~/.aq/config.json, CLI / SDK overrides."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from protocol.recipe import parse_recipe

KNOWN_CHARTS = ("metrics", "jobs", "runs", "samples", "vision")


def _global_plot() -> dict[str, Any]:
    p = Path.home() / ".aq" / "config.json"
    if not p.is_file():
        return {}
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    block = cfg.get("plot")
    return dict(block) if isinstance(block, dict) else {}


def _recipe_plot(train: Path) -> dict[str, Any]:
    recipe = train / "recipe.yaml"
    if not recipe.is_file():
        return {}
    rec = parse_recipe(recipe)
    block = rec.get("plot")
    return dict(block) if isinstance(block, dict) else {}


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in overlay.items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)  # type: ignore[arg-type]
        else:
            out[k] = v
    return out


def _as_list(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        return [c.strip() for c in v.split(",") if c.strip()]
    return [str(v)]


def _as_figsize(v: Any) -> tuple[float, float] | None:
    if v is None:
        return None
    if isinstance(v, (list, tuple)) and len(v) >= 2:
        try:
            return (float(v[0]), float(v[1]))
        except (TypeError, ValueError):
            return None
    if isinstance(v, str) and "," in v:
        a, b = v.split(",", 1)
        try:
            return (float(a.strip()), float(b.strip()))
        except ValueError:
            return None
    return None


def _normalize(cfg: dict[str, Any]) -> dict[str, Any]:
    charts = _as_list(cfg.get("charts"))
    if charts is None:
        charts = ["metrics", "jobs", "runs"]
    # normalize vision → samples in charts list
    charts = ["samples" if c == "vision" else c for c in charts]

    try:
        dpi = int(cfg.get("dpi") or 150)
    except (TypeError, ValueError):
        dpi = 150

    fmt = str(cfg.get("format") or "png").lower().lstrip(".")
    if fmt not in ("png", "svg", "pdf"):
        fmt = "png"

    metrics = dict(cfg.get("metrics") or {}) if isinstance(cfg.get("metrics"), dict) else {}
    samples = dict(cfg.get("samples") or {}) if isinstance(cfg.get("samples"), dict) else {}
    jobs = dict(cfg.get("jobs") or {}) if isinstance(cfg.get("jobs"), dict) else {}
    runs = dict(cfg.get("runs") or {}) if isinstance(cfg.get("runs"), dict) else {}

    # Flat CLI / SDK keys win over nested defaults
    for key in ("fields", "x", "style", "show_lr", "metric_charts", "figsize", "title"):
        if key in cfg and cfg[key] is not None and not isinstance(cfg[key], dict):
            if key == "title" and cfg.get("kind") not in (None, "metrics", "all"):
                pass
            else:
                metrics[key] = cfg[key]
    if cfg.get("title") and cfg.get("kind") == "metrics":
        metrics["title"] = cfg["title"]

    for key in ("max", "thumb", "nrow", "dirs", "backend"):
        if key in cfg and cfg[key] is not None and not isinstance(cfg[key], dict):
            samples[key] = cfg[key]
    if cfg.get("from") is not None:
        samples["dirs"] = cfg["from"]
    if cfg.get("title") and cfg.get("kind") in ("samples", "vision"):
        samples["title"] = cfg["title"]
    if cfg.get("title") and cfg.get("kind") == "jobs":
        jobs["title"] = cfg["title"]
    if cfg.get("title") and cfg.get("kind") == "runs":
        runs["title"] = cfg["title"]

    if "fields" in metrics:
        metrics["fields"] = _as_list(metrics["fields"]) or metrics["fields"]
    if "metric_charts" in metrics:
        metrics["metric_charts"] = _as_list(metrics["metric_charts"]) or ["loss"]
    if "charts" in metrics and isinstance(metrics.get("charts"), (list, str)) and "metric_charts" not in metrics:
        metrics["metric_charts"] = _as_list(metrics["charts"])
    fz = _as_figsize(metrics.get("figsize") or cfg.get("figsize"))
    if fz:
        metrics["figsize"] = list(fz)
    fz_j = _as_figsize(jobs.get("figsize"))
    if fz_j:
        jobs["figsize"] = list(fz_j)
    fz_r = _as_figsize(runs.get("figsize"))
    if fz_r:
        runs["figsize"] = list(fz_r)
    fz_s = _as_figsize(samples.get("figsize"))
    if fz_s:
        samples["figsize"] = list(fz_s)

    if "dirs" in samples:
        samples["dirs"] = _as_list(samples["dirs"]) or samples["dirs"]
    for int_key in ("max", "thumb", "nrow"):
        if int_key in samples and samples[int_key] is not None:
            try:
                samples[int_key] = int(samples[int_key])
            except (TypeError, ValueError):
                pass

    return {
        "format": fmt,
        "dpi": dpi,
        "out": str(cfg.get("out") or "artifacts/plots"),
        "charts": charts,
        "auto": bool(cfg.get("auto")),
        "kind": cfg.get("kind"),
        "title": cfg.get("title"),
        "metrics": metrics,
        "samples": samples,
        "jobs": jobs,
        "runs": runs,
    }


def resolve_plot_config(train: Path, req: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Precedence (low → high): defaults → ~/.aq/config.json plot → recipe plot → req.

    req may be flat CLI fields and/or nested {metrics, samples, jobs, runs}.
    """
    req = dict(req or {})
    nested = req.pop("plot", None)
    if isinstance(nested, dict):
        req = _deep_merge(nested, req)

    merged: dict[str, Any] = {
        "format": "png",
        "dpi": 150,
        "out": "artifacts/plots",
        "charts": ["metrics", "jobs", "runs"],
        "auto": False,
        "metrics": {
            "fields": ["loss"],
            "x": "step",
            "style": "line",
            "show_lr": True,
            "figsize": [7, 4],
            "metric_charts": ["loss", "eval", "duration"],
        },
        "samples": {
            "max": 64,
            "thumb": 128,
            "nrow": 8,
            "backend": "auto",
        },
        "jobs": {"figsize": [6, 4]},
        "runs": {"figsize": [6, 4]},
    }
    for src in (_global_plot(), _recipe_plot(train), req):
        if not src:
            continue
        merged = _deep_merge(merged, src)
    return _normalize(merged)


def should_auto_plot(train: Path) -> bool:
    cfg = resolve_plot_config(train, {})
    return bool(cfg.get("auto"))


def chart_options(cfg: dict[str, Any], name: str) -> dict[str, Any]:
    """Per-chart options block (metrics/samples/jobs/runs)."""
    key = "samples" if name == "vision" else name
    block = cfg.get(key)
    return dict(block) if isinstance(block, dict) else {}
