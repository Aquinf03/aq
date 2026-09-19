"""Job status chart from jobs/*/spec.json."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt

from plot.render import apply_theme, save_fig

STATUSES = ("queued", "starting", "running", "exited", "canceled", "error")
COLORS = {
    "queued": "#94a3b8",
    "starting": "#f59e0b",
    "running": "#2563eb",
    "exited": "#16a34a",
    "canceled": "#64748b",
    "error": "#dc2626",
}


def plot_jobs(
    train: Path,
    out_dir: Path,
    *,
    fmt: str,
    dpi: int,
    opts: dict | None = None,
) -> Path | None:
    opts = opts or {}
    jobs_dir = train / "jobs"
    if not jobs_dir.is_dir():
        return None

    counts = {s: 0 for s in STATUSES}
    total = 0
    for spec_path in sorted(jobs_dir.iterdir()):
        if not spec_path.is_dir():
            continue
        p = spec_path / "spec.json"
        if not p.is_file():
            continue
        try:
            spec = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        status = str(spec.get("status") or "queued").lower()
        if status not in counts:
            status = "error"
        counts[status] += 1
        total += 1

    if total == 0:
        return None

    labels = [s for s in STATUSES if counts[s] > 0]
    values = [counts[s] for s in labels]
    colors = [COLORS[s] for s in labels]
    title = str(opts.get("title") or f"jobs ({total} total)")
    fz = opts.get("figsize") or [6, 4]
    try:
        figsize = (float(fz[0]), float(fz[1]))
    except (TypeError, ValueError, IndexError):
        figsize = (6, 4)

    apply_theme()
    fig, ax = plt.subplots(figsize=figsize)
    ax.bar(labels, values, color=colors)
    ax.set_title(title)
    ax.set_ylabel("count")
    ax.set_xlabel("status")
    plt.xticks(rotation=25, ha="right")

    out = out_dir / f"jobs.{fmt}"
    save_fig(out, dpi=dpi)
    return out
