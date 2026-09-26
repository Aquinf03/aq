"""Loss / lr curves and fallbacks from artifacts/metrics.jsonl."""

from __future__ import annotations

from protocol.paths import art_dir
import json
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt

from plot.render import apply_theme, save_fig


def _read_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _figsize(opts: dict[str, Any], default: tuple[float, float] = (7, 4)) -> tuple[float, float]:
    fz = opts.get("figsize")
    if isinstance(fz, (list, tuple)) and len(fz) >= 2:
        try:
            return (float(fz[0]), float(fz[1]))
        except (TypeError, ValueError):
            pass
    return default


def _plot_steps(out_dir: Path, *, fmt: str, dpi: int, rows: list[dict], opts: dict[str, Any]) -> Path | None:
    x_key = str(opts.get("x") or "step")
    fields = opts.get("fields") or ["loss"]
    if isinstance(fields, str):
        fields = [f.strip() for f in fields.split(",") if f.strip()]
    fields = [str(f) for f in fields]
    if not fields:
        fields = ["loss"]
    y_key = fields[0]
    show_lr = opts.get("show_lr")
    if show_lr is None:
        show_lr = "lr" in fields or len(fields) > 1
    style = str(opts.get("style") or "line").lower()
    title = str(opts.get("title") or f"training {y_key}")

    xs: list[float] = []
    ys: list[float] = []
    lrs: list[float] = []
    for row in rows:
        if row.get("event") != "step":
            continue
        x_raw = row.get(x_key) if x_key != "step" else row.get("step")
        y_raw = row.get(y_key)
        if x_raw is None or y_raw is None:
            continue
        try:
            xs.append(float(x_raw))
            ys.append(float(y_raw))
        except (TypeError, ValueError):
            continue
        if show_lr:
            lr = row.get("lr")
            if lr is not None:
                try:
                    lrs.append(float(lr))
                except (TypeError, ValueError):
                    lrs.append(float("nan"))

    if not xs:
        return None

    infra_marks: list[tuple[float, str]] = []
    for row in rows:
        if row.get("event") != "infra":
            continue
        raw = row.get("step")
        if raw is None:
            continue
        try:
            sx = float(raw)
        except (TypeError, ValueError):
            continue
        kind = str(row.get("kind") or "infra")
        infra_marks.append((sx, kind))

    apply_theme()
    fig, ax1 = plt.subplots(figsize=_figsize(opts, (7, 4)))
    if style == "scatter":
        ax1.scatter(xs, ys, color="#2563eb", label=y_key, s=12)
    elif style == "bar":
        ax1.bar(xs, ys, color="#2563eb", label=y_key, width=max((xs[-1] - xs[0]) / max(len(xs), 1) * 0.8, 0.5))
    else:
        ax1.plot(xs, ys, color="#2563eb", label=y_key, marker="o", markersize=3)
    ax1.set_xlabel(x_key)
    ax1.set_ylabel(y_key)
    ax1.set_title(title)
    ax1.grid(True)

    # Infra badges on the same step axis as loss (OOM / preempt / disk / …).
    if infra_marks and opts.get("infra", True) is not False:
        y_lo, y_hi = ax1.get_ylim()
        labeled: set[str] = set()
        for sx, kind in infra_marks:
            if sx < min(xs) or sx > max(xs):
                continue
            lab = kind if kind not in labeled else None
            ax1.axvline(sx, color="#ca8a04", linestyle=":", linewidth=1.2, alpha=0.85, label=lab)
            if lab:
                labeled.add(kind)
            ax1.annotate(
                kind,
                xy=(sx, y_hi),
                xytext=(0, -4),
                textcoords="offset points",
                ha="center",
                va="top",
                fontsize=8,
                color="#a16207",
            )

    if show_lr and lrs and len(lrs) == len(xs):
        ax2 = ax1.twinx()
        ax2.plot(xs, lrs, color="#16a34a", label="lr", linestyle="--", alpha=0.85)
        ax2.set_ylabel("lr")
        lines1, labels1 = ax1.get_legend_handles_labels()
        lines2, labels2 = ax2.get_legend_handles_labels()
        ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper right")
    else:
        ax1.legend(loc="upper right")

    out = out_dir / f"{y_key}.{fmt}"
    save_fig(out, dpi=dpi)
    return out


def _plot_eval_scores(out_dir: Path, *, fmt: str, dpi: int, rows: list[dict], opts: dict[str, Any]) -> Path | None:
    points: list[tuple[int, float, str]] = []
    for row in rows:
        if row.get("event") not in ("eval.probe", "end"):
            continue
        if row.get("event") == "end" and row.get("op") != "eval":
            continue
        score = row.get("score")
        if score is None:
            continue
        try:
            val = float(score)
        except (TypeError, ValueError):
            continue
        metric = str(row.get("metric") or "score")
        points.append((len(points) + 1, val, metric))

    if not points:
        return None

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    metric = points[-1][2]
    title = str(opts.get("title") or "eval scores")
    style = str(opts.get("style") or "line").lower()

    apply_theme()
    fig, ax = plt.subplots(figsize=_figsize(opts, (6, 4)))
    if style == "bar":
        ax.bar(xs, ys, color="#7c3aed")
    elif style == "scatter":
        ax.scatter(xs, ys, color="#7c3aed")
    else:
        ax.plot(xs, ys, color="#7c3aed", marker="o")
    ax.set_xlabel("eval #")
    ax.set_ylabel(metric)
    ax.set_title(title)
    ax.grid(True)

    out = out_dir / f"eval-scores.{fmt}"
    save_fig(out, dpi=dpi)
    return out


def _plot_train_elapsed(out_dir: Path, *, fmt: str, dpi: int, rows: list[dict], opts: dict[str, Any]) -> Path | None:
    xs: list[int] = []
    ys: list[float] = []
    for row in rows:
        if row.get("event") != "end" or row.get("op") != "train":
            continue
        ms = row.get("elapsed_ms")
        if ms is None:
            continue
        try:
            xs.append(len(xs) + 1)
            ys.append(float(ms))
        except (TypeError, ValueError):
            continue

    if not xs:
        return None

    title = str(opts.get("title") or "train duration")
    apply_theme()
    fig, ax = plt.subplots(figsize=_figsize(opts, (6, 4)))
    ax.bar(xs, ys, color="#2563eb")
    ax.set_xlabel("train run #")
    ax.set_ylabel("elapsed_ms")
    ax.set_title(title)
    ax.grid(True, axis="y")

    out = out_dir / f"train-duration.{fmt}"
    save_fig(out, dpi=dpi)
    return out


def plot_metrics(
    train: Path,
    out_dir: Path,
    *,
    fmt: str,
    dpi: int,
    opts: dict[str, Any] | None = None,
) -> Path | None:
    opts = opts or {}
    path = art_dir(train) /  "metrics.jsonl"
    if not path.is_file():
        return None

    rows = _read_rows(path)
    wanted = opts.get("metric_charts") or ["loss", "eval", "duration"]
    if isinstance(wanted, str):
        wanted = [c.strip() for c in wanted.split(",") if c.strip()]
    wanted = [str(c).lower() for c in wanted]

    mapping = {
        "loss": _plot_steps,
        "steps": _plot_steps,
        "eval": _plot_eval_scores,
        "eval-scores": _plot_eval_scores,
        "duration": _plot_train_elapsed,
        "train-duration": _plot_train_elapsed,
    }
    first: Path | None = None
    for name in wanted:
        fn = mapping.get(name)
        if not fn:
            continue
        out = fn(out_dir, fmt=fmt, dpi=dpi, rows=rows, opts=opts)
        if out is not None and first is None:
            first = out
    return first
