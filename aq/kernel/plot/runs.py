"""Compare run records from artifacts/runs/*.json."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt

from plot.render import apply_theme, save_fig


def plot_runs(
    train: Path,
    out_dir: Path,
    *,
    fmt: str,
    dpi: int,
    opts: dict | None = None,
) -> Path | None:
    opts = opts or {}
    runs_dir = train / "artifacts" / "runs"
    if not runs_dir.is_dir():
        return None

    points: list[tuple[str, float, str]] = []
    for p in sorted(runs_dir.glob("*.json")):
        if p.name == "last.json":
            continue
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        metrics = body.get("metrics") or {}
        score = metrics.get("score")
        if score is None:
            continue
        try:
            val = float(score)
        except (TypeError, ValueError):
            continue
        rid = str(body.get("id") or p.stem)
        metric = str(metrics.get("metric") or "score")
        points.append((rid, val, metric))

    if not points:
        return None

    labels = [p[0][-12:] if len(p[0]) > 12 else p[0] for p in points]
    values = [p[1] for p in points]
    metric_name = points[-1][2]
    title = str(opts.get("title") or "run comparison")
    fz = opts.get("figsize") or [max(6, len(points) * 0.55), 4]
    try:
        figsize = (float(fz[0]), float(fz[1]))
    except (TypeError, ValueError, IndexError):
        figsize = (max(6, len(points) * 0.55), 4)

    apply_theme()
    fig, ax = plt.subplots(figsize=figsize)
    bars = ax.bar(range(len(values)), values, color="#7c3aed")
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=35, ha="right")
    ax.set_ylabel(metric_name)
    ax.set_title(title)
    ax.grid(True, axis="y")
    for bar, val in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height(),
            f"{val:.4g}",
            ha="center",
            va="bottom",
            fontsize=8,
        )

    out = out_dir / f"runs.{fmt}"
    save_fig(out, dpi=dpi)
    return out
