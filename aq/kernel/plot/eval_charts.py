"""Browse / re-emit classical eval suite plots under artifacts/plots/."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from protocol.paths import art_dir

KINDS = ("confusion", "roc", "pr", "residuals", "pred", "pred_vs_true", "all")


def plot_eval(train: Path, out_dir: Path, *, fmt: str, dpi: int, opts: dict[str, Any]) -> Path | None:
    """Renderer entry for ``aq plot eval`` — prefer already-logged plots; else hint."""
    del fmt  # png already written by suite
    chart = str(opts.get("chart") or opts.get("fields") or "all").lower()
    if isinstance(opts.get("fields"), list) and opts["fields"]:
        chart = str(opts["fields"][0]).lower()
    if chart in ("pred_vs_true",):
        chart = "pred"
    plots_dir = art_dir(train) / "plots"
    # Map kind → filename stems written by eval_suite
    stems = {
        "confusion": ["confusion"],
        "roc": ["roc"],
        "pr": ["pr"],
        "residuals": ["residuals"],
        "pred": ["pred_vs_true", "pred"],
        "all": ["confusion", "roc", "pr", "residuals", "pred_vs_true"],
    }
    want = stems.get(chart, [chart])
    found: list[Path] = []
    if plots_dir.is_dir():
        for p in sorted(plots_dir.iterdir()):
            if not p.is_file():
                continue
            stem = p.stem.lower()
            for w in want:
                if stem == w or stem.endswith("_" + w):
                    found.append(p)
                    break
    # Also honor paths recorded in metrics.jsonl
    for rel in _paths_from_metrics(train, want if chart != "all" else None):
        p = train / rel if not Path(rel).is_absolute() else Path(rel)
        if p.is_file() and p not in found:
            found.append(p)
    if not found:
        return None
    # Copy/select into out_dir if different; return first (do_plot lists all via multi-call —
    # we return the newest matching file; caller lists one path. For all, write a small index.)
    out_dir.mkdir(parents=True, exist_ok=True)
    if chart == "all" and len(found) > 1:
        index = out_dir / "eval_plots.txt"
        lines = []
        for p in found:
            dest = out_dir / p.name
            if dest.resolve() != p.resolve():
                dest.write_bytes(p.read_bytes())
            try:
                lines.append(str(dest.relative_to(train)))
            except ValueError:
                lines.append(str(dest))
        index.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return index
    src = found[-1]
    dest = out_dir / src.name
    if dest.resolve() != src.resolve():
        dest.write_bytes(src.read_bytes())
        return dest
    return src


def _paths_from_metrics(train: Path, kinds: list[str] | None) -> list[str]:
    path = art_dir(train) / "metrics.jsonl"
    if not path.is_file():
        return []
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("event") != "eval.plot":
            continue
        kind = str(row.get("kind") or "")
        if kinds is not None and kind not in kinds and not (kind == "pred" and "pred" in (kinds or [])):
            if kind == "pred_vs_true" and "pred" in (kinds or []):
                pass
            else:
                continue
        rel = row.get("path")
        if isinstance(rel, str):
            out.append(rel)
    return out
