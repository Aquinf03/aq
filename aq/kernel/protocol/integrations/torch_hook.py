"""Raw PyTorch — Optimizer.step heartbeat + optional grad/param norms.

Patch is installed when:
  - ``AQ_TORCH_AUTOLOG=1`` (step heartbeat events), or
  - ``force=True`` / grads session enabled (grad norms before step)

``integrations.install(['torch'])`` still returns True when torch is importable.
"""

from __future__ import annotations

import os

_orig_step = None
_patched = False
_step_i = 0
_heartbeat = False


def apply(*, disable: bool = False, force: bool = False) -> bool:
    global _orig_step, _patched, _step_i, _heartbeat
    try:
        import torch
        from torch.optim.optimizer import Optimizer
    except ImportError:
        return False

    if disable:
        if _patched and _orig_step is not None:
            Optimizer.step = _orig_step  # type: ignore[method-assign]
            _patched = False
        return True

    heartbeat = os.environ.get("AQ_TORCH_AUTOLOG", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    want_grads = force
    if not want_grads:
        try:
            from protocol import grads as aq_grads

            want_grads = aq_grads.enabled()
        except Exception:
            want_grads = False

    if not heartbeat and not want_grads and not force:
        # Available but no patch yet — grads.enable() will force=True later.
        return True

    _heartbeat = heartbeat

    if _patched:
        return True

    _orig_step = Optimizer.step
    _step_i = 0

    def step(self, *args, **kwargs):  # noqa: ANN001
        global _step_i
        try:
            from protocol import grads as aq_grads

            if aq_grads.enabled():
                aq_grads.maybe_from_optimizer(self, step=_step_i + 1)
        except Exception:
            pass
        out = _orig_step(self, *args, **kwargs)
        try:
            from protocol import metrics as aq_metrics

            if aq_metrics.active_run_id() is None:
                return out
            _step_i += 1
            if _heartbeat and (_step_i == 1 or _step_i % 50 == 0):
                aq_metrics.event("torch.step", step=_step_i)
        except Exception:
            pass
        return out

    Optimizer.step = step  # type: ignore[method-assign]
    _patched = True
    return True
