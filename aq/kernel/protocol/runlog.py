"""Standard run logging — params, metrics, tags, notes (folder-first).

Writes:
  artifacts/metrics.jsonl   params / metric / tags / notes events
  artifacts/runs/<id>.json  tags, notes, params (merged on write_run / patch)

Used by aquin.log_* and during aq train (same metrics session).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

_state: dict[str, Any] = {
    "tags": [],
    "notes": None,
    "params": {},
}


def reset() -> None:
    _state["tags"] = []
    _state["notes"] = None
    _state["params"] = {}


def snapshot() -> dict[str, Any]:
    """Copy of session meta for write_run (does not clear)."""
    out: dict[str, Any] = {}
    tags = list(_state.get("tags") or [])
    if tags:
        out["tags"] = tags
    notes = _state.get("notes")
    if notes is not None and str(notes).strip() != "":
        out["notes"] = str(notes)
    params = dict(_state.get("params") or {})
    if params:
        out["params"] = params
    return out


def take() -> dict[str, Any]:
    """Consume session meta (after write_run)."""
    out = snapshot()
    reset()
    return out


def log_params(params: dict[str, Any]) -> None:
    """Record hyperparameters (merged into session + metrics.jsonl)."""
    from protocol import metrics as aq_metrics
    from protocol import autolog

    if not isinstance(params, dict) or not params:
        return
    flat = {str(k): v for k, v in params.items() if v is not None}
    merged = dict(_state.get("params") or {})
    merged.update(flat)
    _state["params"] = merged
    # Prefer autolog path (params event) when a train session exists.
    if aq_metrics.active_run_id() is not None or autolog.enabled():
        autolog.log_params(flat)
    else:
        aq_metrics.event("params", **flat)


def log_metric(key: str, value: float | int, *, step: int | None = None) -> None:
    log_metrics({key: value}, step=step)


def log_metrics(metrics: dict[str, Any], *, step: int | None = None) -> None:
    """Log one or more scalar metrics. ``loss`` / ``train_loss`` → step event."""
    from protocol import metrics as aq_metrics

    if not isinstance(metrics, dict) or not metrics:
        return
    clean: dict[str, Any] = {}
    for k, v in metrics.items():
        if v is None:
            continue
        try:
            clean[str(k)] = float(v)
        except (TypeError, ValueError):
            clean[str(k)] = v

    loss = clean.get("loss")
    if loss is None:
        loss = clean.get("train_loss")
    # Step-shaped when we have a step index or an explicit loss.
    if step is not None or loss is not None:
        fields = {k: v for k, v in clean.items() if k not in ("loss", "train_loss")}
        if loss is not None:
            fields["loss"] = float(loss)
        aq_metrics.step(step=step, **fields)
        return
    aq_metrics.event("metric", **clean)


def set_tags(*tags: str, replace: bool = False) -> list[str]:
    """Add tags (or replace). Persisted on the run record."""
    from protocol import metrics as aq_metrics

    incoming = [str(t).strip() for t in tags if str(t).strip()]
    if replace:
        cur: list[str] = []
    else:
        cur = list(_state.get("tags") or [])
    for t in incoming:
        if t not in cur:
            cur.append(t)
    _state["tags"] = cur
    if aq_metrics.active_run_id() is not None:
        aq_metrics.event("tags", tags=list(cur))
    _patch_active_run({"tags": list(cur)})
    return list(cur)


def add_tags(*tags: str) -> list[str]:
    return set_tags(*tags, replace=False)


def clear_tags() -> None:
    _state["tags"] = []
    from protocol import metrics as aq_metrics

    if aq_metrics.active_run_id() is not None:
        aq_metrics.event("tags", tags=[])
    _patch_active_run({"tags": []})


def get_tags() -> list[str]:
    return list(_state.get("tags") or [])


def set_notes(text: str | None) -> str:
    """Set free-text notes on the run."""
    from protocol import metrics as aq_metrics

    notes = "" if text is None else str(text)
    _state["notes"] = notes
    if aq_metrics.active_run_id() is not None:
        aq_metrics.event("notes", notes=notes)
    _patch_active_run({"notes": notes})
    return notes


def get_notes() -> str | None:
    n = _state.get("notes")
    return None if n is None else str(n)


def _patch_active_run(fields: dict[str, Any]) -> None:
    """Update last/active run JSON in place when a train folder is live."""
    from protocol import metrics as aq_metrics
    from protocol.record import runs_dir

    train = None
    # metrics._state train path
    try:
        train = aq_metrics._state.get("train")  # type: ignore[attr-defined]
    except Exception:
        train = None
    if train is None:
        return
    train = Path(train)
    d = runs_dir(train)
    last = d / "last.json"
    if not last.is_file():
        return
    try:
        import json

        body = json.loads(last.read_text(encoding="utf-8"))
        body.update(fields)
        text = json.dumps(body, indent=2) + "\n"
        last.write_text(text, encoding="utf-8")
        rid = body.get("id")
        if rid:
            (d / (str(rid) + ".json")).write_text(text, encoding="utf-8")
        from protocol.record import write_summary

        write_summary(d, body)
    except Exception:
        pass
