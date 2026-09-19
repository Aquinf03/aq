"""Read train artifacts and write charts under artifacts/plots/."""

from __future__ import annotations

from protocol.paths import art_dir
from pathlib import Path
from typing import Any, Callable

from plot.config import chart_options, resolve_plot_config


def _renderers() -> dict[str, Callable[..., Path | None]]:
    from plot.jobs import plot_jobs
    from plot.metrics import plot_metrics
    from plot.runs import plot_runs
    from plot.vision import plot_vision

    return {
        "metrics": plot_metrics,
        "jobs": plot_jobs,
        "runs": plot_runs,
        "samples": plot_vision,
        "vision": plot_vision,
    }


def do_plot(train: Path, req: dict[str, Any] | None = None) -> list[str]:
    req = req or {}
    import os

    mpl_dir = art_dir(train) / ".matplotlib"
    mpl_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(mpl_dir))

    cfg = resolve_plot_config(train, req)
    fmt = str(cfg["format"])
    dpi = int(cfg["dpi"])
    kind = str(req.get("kind") or cfg.get("kind") or "all").lower()

    from protocol.paths import peek_recipe, rel as path_rel

    default_out = f"{path_rel(peek_recipe(train), 'artifacts')}/plots"
    out_rel = str(req.get("out") or cfg.get("out") or default_out)
    if out_rel in ("artifacts/plots", "artifacts\\plots"):
        out_rel = default_out
    out_file = req.get("out_file")
    if out_file:
        out_dir = Path(out_file).parent
        single_name = Path(out_file).stem
    else:
        out_dir = train / out_rel
        single_name = None

    if kind == "all":
        charts = list(cfg.get("charts") or ["metrics", "jobs", "runs"])
        if req.get("include_samples") is True and "samples" not in charts:
            charts = [*charts, "samples"]
        # Soft-add samples when not explicitly excluded
        if req.get("no_samples") is not True and "samples" not in charts and "vision" not in charts:
            charts = [*charts, "samples"]
    elif kind in ("charts", "custom"):
        charts = list(cfg.get("charts") or ["metrics"])
    else:
        charts = [kind]

    # Explicit --charts overrides kind=all list
    if req.get("charts") and kind == "all":
        charts = list(cfg["charts"])

    renderers = _renderers()
    written: list[Path] = []
    skipped: list[str] = []
    for name in charts:
        fn = renderers.get(name)
        if fn is None:
            skipped.append(f"unknown chart: {name}")
            continue
        opts = chart_options(cfg, name)
        path = fn(train, out_dir, fmt=fmt, dpi=dpi, opts=opts)
        if path is None:
            skipped.append(f"no data for {name}")
            continue
        active = [c for c in charts if c in renderers]
        if single_name and len(active) == 1:
            dest = out_dir / f"{single_name}{path.suffix}"
            if dest != path:
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.replace(dest)
                path = dest
        written.append(path)

    if not written:
        hint = "; ".join(skipped) if skipped else "nothing to plot"
        raise SystemExit(f"plot: {hint}")

    lines = []
    for p in written:
        try:
            lines.append(str(p.relative_to(train)))
        except ValueError:
            lines.append(str(p))
    return lines
