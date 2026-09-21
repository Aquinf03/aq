"""Raw PyTorch — light touch: log optimizer.step count when AQ_TORCH_AUTOLOG=1.

Default off inside the torch adapter registration so normal training isn't slowed;
`integrations.install(['torch'])` still returns True and documents the env gate,
or enables a no-op-safe Optimizer.step counter when a metrics session is active.
"""

from __future__ import annotations

import os

_orig_step = None
_patched = False
_step_i = 0


def apply(*, disable: bool = False) -> bool:
    global _orig_step, _patched, _step_i
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

    if _patched:
        return True

    # Only patch when explicitly requested via env (avoid slowing every step by default).
    # Lightning / transformers cover the common high-level paths.
    if os.environ.get("AQ_TORCH_AUTOLOG", "").strip().lower() not in ("1", "true", "yes", "on"):
        return True  # "available" but no patch — still counts as integrated entry

    _orig_step = Optimizer.step
    _step_i = 0

    def step(self, *args, **kwargs):  # noqa: ANN001
        global _step_i
        out = _orig_step(self, *args, **kwargs)
        try:
            from protocol import metrics as aq_metrics

            if aq_metrics.active_run_id() is None:
                return out
            _step_i += 1
            # Loss not available on Optimizer.step — emit step heartbeat only every N.
            if _step_i == 1 or _step_i % 50 == 0:
                aq_metrics.event("torch.step", step=_step_i)
        except Exception:
            pass
        return out

    Optimizer.step = step  # type: ignore[method-assign]
    _patched = True
    return True
