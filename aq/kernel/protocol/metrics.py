"""Live observability log: artifacts/metrics.jsonl (one JSON object per line).

TTY → op-specific dashboard (train_tui / eval_tui).
Pipes/CI → plain append tables (protocol.term_table).
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.guard import GuardAbort, SafetyWatch, parse_guard
from protocol.paths import art_dir

_state: dict[str, Any] = {
    "train": None,
    "run_id": None,
    "op": None,
    "t0": None,
    "step": -1,
    "steps": None,
    "guard": None,
    "watch": None,
    "step_header": False,
    "epoch_header": False,
    "step_cols": None,
    "step_widths": None,
}

# Survives end() so write_run can attach console / estimator paths.
_last_autolog_artifacts: dict[str, str] = {}
_last_run_id: str | None = None


def metrics_path(train: Path) -> Path:
    return art_dir(train) /  "metrics.jsonl"


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _elapsed_ms() -> int | None:
    t0 = _state.get("t0")
    if t0 is None:
        return None
    return int((time.perf_counter() - float(t0)) * 1000)


def _reset_tuis() -> None:
    from protocol import eval_tui, train_tui

    train_tui.reset()
    eval_tui.reset()


def active_run_id() -> str | None:
    rid = _state.get("run_id") or _last_run_id
    return str(rid) if rid else None


def begin(
    train: Path,
    *,
    op: str,
    run_id: str | None = None,
    recipe: dict | None = None,
    **meta: Any,
) -> str:
    """Start a metrics session for this process. Returns run_id."""
    from protocol import autolog

    _reset_tuis()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    rh = meta.get("recipe_hash")
    if isinstance(rh, str) and len(rh) >= 8:
        default_rid = stamp + "-" + rh[-8:]
    else:
        default_rid = stamp
    rid = run_id or default_rid
    cfg = parse_guard(recipe or {})
    _state["train"] = Path(train)
    _state["run_id"] = rid
    _state["op"] = op
    _state["t0"] = time.perf_counter()
    _state["step"] = -1
    _state["guard"] = cfg
    _state["watch"] = SafetyWatch(cfg) if cfg.get("safety") else None
    _state["step_header"] = False
    _state["epoch_header"] = False
    _state["step_cols"] = None
    _state["step_widths"] = None

    steps = meta.get("steps")
    if steps is None and recipe:
        steps = recipe.get("steps")
    try:
        _state["steps"] = int(steps) if steps is not None else None
    except (TypeError, ValueError):
        _state["steps"] = None

    if recipe and recipe.get("epochs") is not None and meta.get("epochs") is None:
        try:
            meta = {**meta, "epochs": int(recipe["epochs"])}
        except (TypeError, ValueError):
            pass

    emit(
        "start",
        op=op,
        run_id=rid,
        guard_safety=bool(cfg.get("safety")),
        guard_leak=bool(cfg.get("leak")),
        **{k: v for k, v in meta.items() if v is not None},
    )
    # Autolog after start so params land under the same run_id.
    autolog.install(Path(train), recipe=recipe, op=op)
    try:
        from protocol import integrations

        hooked = integrations.install()
        if hooked:
            emit("integrations", frameworks=hooked)
    except Exception:
        pass
    return rid


def end(**meta: Any) -> dict[str, str]:
    """Finish autolog + emit end. Returns autolog artifact paths for write_run."""
    global _last_autolog_artifacts, _last_run_id
    from protocol import autolog

    _last_run_id = str(_state["run_id"]) if _state.get("run_id") else None
    arts = autolog.finish()
    _last_autolog_artifacts = dict(arts)
    merged = {k: v for k, v in meta.items() if v is not None}
    if arts.get("console") and "console" not in merged:
        merged["console"] = arts["console"]
    emit("end", **merged)
    _reset_tuis()
    for k in list(_state.keys()):
        if k in ("step_header", "epoch_header"):
            _state[k] = False
        elif k in ("step",):
            _state[k] = -1
        else:
            _state[k] = None
    return dict(arts)


def take_autolog_artifacts() -> dict[str, str]:
    """Consume artifact map left by the last end() (for write_run)."""
    global _last_autolog_artifacts, _last_run_id
    arts = dict(_last_autolog_artifacts)
    _last_autolog_artifacts = {}
    _last_run_id = None
    return arts


def emit(event: str, **fields: Any) -> None:
    """Append one observability record. Safe no-op if begin() was never called."""
    train = _state.get("train")
    if train is None:
        return
    train = Path(train)
    body: dict[str, Any] = {"ts": _iso(), "event": event}
    if _state.get("run_id"):
        body["run_id"] = _state["run_id"]
    if _state.get("op"):
        body["op"] = _state["op"]
    elapsed = _elapsed_ms()
    if elapsed is not None:
        body["elapsed_ms"] = elapsed
    if event == "step" and _state.get("steps") is not None:
        body["steps"] = _state["steps"]
    for k, v in fields.items():
        if v is None:
            continue
        if k in body and k != "event":
            continue
        body[k] = v
    path = metrics_path(train)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(body, default=_json_default) + "\n")
        f.flush()
    _print_live(event, body)


def _print_live(event: str, body: dict[str, Any]) -> None:
    from protocol import eval_tui, train_tui
    from protocol.term_table import fmt_cell, print_kv, print_table, render_table

    op = str(_state.get("op") or body.get("op") or "")

    if op == "eval":
        et = eval_tui.get()
        if et is not None and event in (
            "start",
            "info",
            "eval.probe",
            "end",
            "error",
            "guard.abort",
        ):
            if event == "start":
                et.on_start(body)
            elif event == "info":
                et.on_info(body)
            elif event == "eval.probe":
                et.on_probe(body)
            elif event == "end":
                et.on_end(body)
            else:
                et.on_error({"error": body.get("error") or body.get("message") or event})
            return
    elif op == "train":
        tui = train_tui.get()
        if tui is not None and event in (
            "start",
            "info",
            "params",
            "code",
            "env",
            "integrations",
            "step",
            "epoch",
            "end",
            "error",
            "guard.abort",
            "guard.warn",
        ):
            if event == "start":
                tui.on_start(body)
            elif event in ("info", "params", "code", "env", "integrations"):
                tui.on_info(body)
            elif event == "step":
                tui.on_step(body)
            elif event == "epoch":
                tui.on_epoch(body)
            elif event == "end":
                tui.on_end(body)
            elif event == "guard.warn":
                tui.on_info({"message": body.get("message") or "guard warn"})
            else:
                tui.on_error({"error": body.get("error") or body.get("message") or event})
            return

    if event == "start":
        rows: list[tuple[str, Any]] = [("op", body.get("op") or "run")]
        if body.get("method"):
            rows.append(("method", body["method"]))
        if body.get("family"):
            rows.append(("family", body["family"]))
        if body.get("checkpoint"):
            rows.append(("checkpoint", body["checkpoint"]))
        print_kv(rows)
        return

    if event in ("info", "params", "code", "env", "integrations"):
        rows = [
            (k, v)
            for k, v in body.items()
            if k not in ("ts", "event", "run_id", "op", "elapsed_ms") and v is not None
        ]
        # Params can be long — show a short head in non-TUI mode.
        if event == "params" and len(rows) > 12:
            rows = rows[:12] + [("…", f"+{len(rows) - 12} more")]
        if event == "integrations" and "frameworks" in body:
            rows = [("frameworks", ", ".join(str(x) for x in (body.get("frameworks") or [])))]
        if rows:
            print_kv(rows)
        return

    if event == "step":
        step_n = int(body.get("step") or 0)
        total = body.get("steps") or _state.get("steps")
        step_label = f"{step_n}/{int(total)}" if total is not None else str(step_n)
        headers = ["step", "loss", "lr", "acc", "epoch", "time"]
        row = [
            step_label,
            body.get("loss"),
            body.get("lr"),
            body.get("acc"),
            body.get("epoch"),
            f"{int(body['elapsed_ms'])}ms" if body.get("elapsed_ms") is not None else None,
        ]
        if not _state.get("step_header"):
            print(render_table(headers, [row]), file=sys.stderr, flush=True)
            cells0 = [fmt_cell(c) for c in row]
            _state["step_widths"] = [max(len(headers[i]), len(cells0[i])) for i in range(6)]
            _state["step_header"] = True
        else:
            widths = list(_state.get("step_widths") or [8] * 6)
            cells = [fmt_cell(c) for c in row]
            for i, c in enumerate(cells):
                widths[i] = max(widths[i], len(c))
            _state["step_widths"] = widths
            parts = [cells[i].rjust(widths[i]) if i else cells[i].ljust(widths[i]) for i in range(6)]
            print("  " + "  ".join(parts), file=sys.stderr, flush=True)
        return

    if event == "epoch":
        headers = ["epoch", "loss", "acc", "val_loss", "val_acc"]
        row = [
            body.get("epoch"),
            body.get("loss") if body.get("loss") is not None else body.get("train_loss"),
            body.get("acc") if body.get("acc") is not None else body.get("train_acc"),
            body.get("val_loss"),
            body.get("val_acc"),
        ]
        if not _state.get("epoch_header"):
            print(render_table(headers, [row]), file=sys.stderr, flush=True)
            _state["epoch_header"] = True
        else:
            cells = [fmt_cell(c) for c in row]
            print("  " + "  ".join(c.rjust(10) for c in cells), file=sys.stderr, flush=True)
        return

    if event == "guard.warn":
        print_kv([("warn", body.get("message") or body.get("reason") or "guard")])
        return

    if event == "guard.abort":
        print_kv([("abort", body.get("message") or body.get("reason") or "aborted")])
        return

    if event == "end":
        rows = []
        for src, label in (
            ("train_loss", "loss"),
            ("train_acc", "acc"),
            ("val_acc", "val_acc"),
        ):
            if body.get(src) is not None:
                rows.append((label, body[src]))
        if body.get("score") is not None:
            rows.append((str(body.get("metric") or "score"), body["score"]))
        if body.get("elapsed_ms") is not None:
            rows.append(("time", f"{int(body['elapsed_ms'])}ms"))
        print("  done", file=sys.stderr, flush=True)
        if rows:
            print_kv(rows)
        return

    if event == "eval.probe":
        v = "pass" if body.get("pass") is True else "fail" if body.get("pass") is False else "—"
        print_table(
            ("probe", "metric", "score", "result"),
            [(body.get("path") or "probe", body.get("metric") or "score", body.get("score"), v)],
        )
        return

    if event == "error":
        print_kv([("error", body.get("error"))])


def step(step: int | None = None, **fields: Any) -> None:
    if step is None:
        _state["step"] = int(_state.get("step") or -1) + 1
        step = int(_state["step"])
    else:
        _state["step"] = int(step)
    watch: SafetyWatch | None = _state.get("watch")
    if watch is not None:
        try:
            warn = watch.check_step(step=int(step), **fields)
        except GuardAbort as e:
            emit(
                "guard.abort",
                reason="safety",
                step=int(step),
                message=str(e),
                loss=fields.get("loss"),
            )
            raise
        if warn:
            emit(
                "guard.warn",
                reason="safety",
                step=int(step),
                message=warn,
                loss=fields.get("loss"),
            )
    emit("step", step=int(step), **fields)


def event(name: str, **fields: Any) -> None:
    emit(name, **fields)


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, (set, tuple)):
        return list(obj)
    return str(obj)


def model_summary(model: dict) -> dict[str, Any]:
    skip = {
        "tok",
        "wout",
        "wcls",
        "block",
        "blocks",
        "W_in",
        "W_out",
        "A",
        "B",
        "coef",
        "weights",
        "trees",
        "itos",
        "stoi",
        "tokenizer",
        "merges",
        "vocab",
    }
    out: dict[str, Any] = {}
    for k, v in model.items():
        if k in skip or k.startswith("_"):
            continue
        if isinstance(v, (list, dict)) and k not in ("features", "classes", "probes"):
            if isinstance(v, list) and v and isinstance(v[0], (list, float, int)):
                if k not in ("features", "classes"):
                    continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
        elif isinstance(v, list) and all(isinstance(x, str) for x in v):
            out[k] = v
            out[k + "_n"] = len(v)
    return out
