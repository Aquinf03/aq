"""Infra events — discrete host/GPU/scheduler incidents on the run timeline.

Always-on for caught OOM / device / recover; SDK can stamp anything::

    from aquin import log_infra
    log_infra("gpu", "Xid 79", xid=79)

Emits ``infra`` events into ``artifacts/metrics.jsonl`` (same stream as loss),
shown as markers in the train TUI and ``aq plot metrics``.

Kinds: oom, gpu, preempt, node, disk, net, retry, signal.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

KINDS = ("oom", "gpu", "preempt", "node", "disk", "net", "retry", "signal")

# Debounce repeated disk warnings within one process.
_disk_warned = False
_DISK_FREE_GB = 2.0
_DISK_USED_PCT = 95.0


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("1", "true", "yes", "on")


def classify(err: BaseException | str | None) -> str | None:
    """Map an exception / message to an infra kind, or None if not infra-shaped."""
    if err is None:
        return None
    msg = str(err).lower()
    if not msg.strip():
        return None
    try:
        from backends.device import is_oom

        if isinstance(err, BaseException) and is_oom(err):
            return "oom"
    except Exception:
        pass
    if "out of memory" in msg or re.search(r"\boom\b", msg):
        return "oom"
    if any(
        s in msg
        for s in (
            "cuda error",
            "cudnn",
            "cublas",
            "device-side assert",
            "illegal memory access",
            "gpu has fallen",
            "xid ",
            "nvml",
            "hip error",
            "mps backend",
            "device lost",
        )
    ):
        return "gpu"
    if any(s in msg for s in ("preempt", "evict", "spot interrupt", "node lost", "node fail")):
        return "preempt"
    if any(s in msg for s in ("no space left", "disk quota", "enospc", "read-only file system")):
        return "disk"
    if any(
        s in msg
        for s in (
            "connection reset",
            "connection timed out",
            "network is unreachable",
            "nfs",
            "broken pipe",
            "host is down",
        )
    ):
        return "net"
    if any(s in msg for s in ("sigkill", "sigterm", "killed", "interrupted by signal")):
        return "signal"
    return None


def emit(kind: str, message: str | None = None, **fields: Any) -> dict[str, Any]:
    """Stamp one infra event onto the active metrics session (no-op if none)."""
    from protocol import metrics as aq_metrics

    k = str(kind or "node").strip().lower() or "node"
    if k not in KINDS:
        k = "node"
    body: dict[str, Any] = {"kind": k}
    if message is not None:
        body["message"] = str(message)[:500]
    step = fields.pop("step", None)
    if step is None:
        st = aq_metrics._state.get("step")  # noqa: SLF001 — shared session
        if st is not None and int(st) >= 0:
            step = int(st)
    if step is not None:
        try:
            body["step"] = int(step)
        except (TypeError, ValueError):
            pass
    for key, val in fields.items():
        if val is None:
            continue
        body[key] = val
    # Compact one-liner for TUI / non-TTY
    label = body.get("message") or k
    body["infra_s"] = f"{k}: {label}" if body.get("message") else k
    aq_metrics.event("infra", **body)
    return body


def emit_from_error(err: BaseException, *, default_kind: str | None = None) -> dict[str, Any] | None:
    """Classify + emit; returns body or None if not an infra-shaped failure."""
    kind = classify(err) or default_kind
    if not kind:
        return None
    return emit(kind, str(err)[:500], error_type=type(err).__name__)


def append(
    train: str | Path,
    kind: str,
    message: str | None = None,
    *,
    run_id: str | None = None,
    op: str | None = None,
    step: int | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """Offline append to ``artifacts/metrics.jsonl`` (no live session required).

    Used by recover / external watchers when the train process is already dead.
    """
    from protocol.paths import art_dir

    train_p = Path(train)
    k = str(kind or "node").strip().lower() or "node"
    if k not in KINDS:
        k = "node"
    body: dict[str, Any] = {"ts": _iso(), "event": "infra", "kind": k}
    if run_id:
        body["run_id"] = str(run_id)
    if op:
        body["op"] = str(op)
    if message is not None:
        body["message"] = str(message)[:500]
    if step is not None:
        try:
            body["step"] = int(step)
        except (TypeError, ValueError):
            pass
    for key, val in fields.items():
        if val is None:
            continue
        body[key] = val
    label = body.get("message") or k
    body["infra_s"] = f"{k}: {label}" if body.get("message") else k
    path = art_dir(train_p) / "metrics.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(body, default=str) + "\n")
        f.flush()
    return body


def stamp_recover_env() -> dict[str, Any] | None:
    """If fleet recover set AQ_RECOVERED / AQ_INFRA_*, emit once then clear.

    Call after metrics.begin so the badge lands on the new run session.
    """
    recovered = _truthy(os.environ.get("AQ_RECOVERED"))
    kind_env = (os.environ.get("AQ_INFRA_KIND") or "").strip().lower()
    msg_env = (os.environ.get("AQ_INFRA_MESSAGE") or "").strip()
    if not recovered and not kind_env:
        return None
    kind = kind_env if kind_env in KINDS else ("preempt" if recovered else "retry")
    if kind_env and kind_env not in KINDS:
        kind = "retry"
    message = msg_env or (
        "job recovered after preempt/unreachable"
        if kind == "preempt"
        else "job recovered / retry"
    )
    body = emit(kind, message, recovered=True, job_id=os.environ.get("AQ_JOB_ID"))
    # One-shot — avoid re-stamping every metrics.begin in the same process.
    os.environ.pop("AQ_RECOVERED", None)
    os.environ.pop("AQ_INFRA_KIND", None)
    os.environ.pop("AQ_INFRA_MESSAGE", None)
    return body


def maybe_disk(sample: dict[str, Any] | None) -> dict[str, Any] | None:
    """Emit a one-shot disk infra event when free space is critically low."""
    global _disk_warned
    if _disk_warned or not isinstance(sample, dict):
        return None
    free = sample.get("disk_free_gb")
    used = sample.get("disk_used_pct")
    low = False
    try:
        if free is not None and float(free) < _DISK_FREE_GB:
            low = True
        if used is not None and float(used) >= _DISK_USED_PCT:
            low = True
    except (TypeError, ValueError):
        return None
    if not low:
        return None
    _disk_warned = True
    bits = []
    if free is not None:
        bits.append(f"{free}G free")
    if used is not None:
        bits.append(f"{used}% used")
    return emit("disk", " · ".join(bits) or "disk low", disk_free_gb=free, disk_used_pct=used)


def reset_disk_warn() -> None:
    global _disk_warned
    _disk_warned = False
