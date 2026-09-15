"""Demo method for guard.safety tests. Stdlib only.

recipe.demo:
  settle  — loss decreases (good run)
  blowup  — loss explodes after warmup (bad run)
  nan     — emits non-finite loss mid-run

Each step sleeps briefly so the run is not instant.
"""

from __future__ import annotations

import math
import time
from pathlib import Path

from protocol import metrics as aq_metrics


def _opt(rec: dict, key: str, default):
    v = rec.get(key)
    if v is None:
        nested = rec.get("watchdemo")
        if isinstance(nested, dict):
            v = nested.get(key)
    return default if v is None else v


def fit(csv_path: Path, rec: dict) -> dict:
    # csv_path unused — synthetic loss curve for the guard watch
    _ = csv_path
    steps = int(_opt(rec, "steps", 40))
    lr = float(_opt(rec, "lr", 0.05))
    demo = str(_opt(rec, "demo", "settle")).lower()
    pause = float(_opt(rec, "pause_ms", 40)) / 1000.0
    if steps < 5:
        raise SystemExit("watchdemo needs steps >= 5")

    last = 0.0
    for step_i in range(steps):
        if demo == "nan" and step_i == max(steps // 2, 3):
            last = float("nan")
        elif demo == "blowup" and step_i >= max(steps // 2, 8):
            # climb hard past blowup_factor * best
            last = 0.4 * (3.0 ** (step_i - steps // 2 + 1))
        else:
            # smooth settle with a little wiggle
            last = 2.2 * math.exp(-0.08 * step_i) + 0.15 + 0.02 * math.sin(step_i)
        aq_metrics.step(step=step_i, loss=last, lr=lr, demo=demo)
        if pause > 0:
            time.sleep(pause)

    return {
        "kind": "watchdemo",
        "demo": demo,
        "steps": steps,
        "lr": lr,
        "train_loss": last,
        "features": ["x"],
        "task": "demo",
    }


def predict(model: dict, X: list[list[float]]) -> list[float]:
    # constant predictor — enough for aq eval to score something
    bias = float(model.get("train_loss") or 0.0)
    return [bias for _ in X]


def write_inspect(train: Path, model: dict) -> str:
    path = train / "artifacts" / "inspect.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# watchdemo",
                "",
                f"demo: {model.get('demo')}",
                f"steps: {model.get('steps')}",
                f"train_loss: {model.get('train_loss')}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return "artifacts/inspect.md"
