"""Hugging Face transformers.Trainer — auto-attach aq metrics callback."""

from __future__ import annotations

_orig_init = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_init, _patched
    try:
        from transformers import Trainer
    except ImportError:
        return False

    if disable:
        if _patched and _orig_init is not None:
            Trainer.__init__ = _orig_init  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    _orig_init = Trainer.__init__

    def __init__(self, *args, **kwargs):  # noqa: ANN001
        from protocol.autolog import hf_trainer_callback

        cbs = list(kwargs.get("callbacks") or [])
        if not any(type(c).__name__ == "AutologTrainerCallback" for c in cbs):
            cbs.append(hf_trainer_callback())
            kwargs["callbacks"] = cbs
        return _orig_init(self, *args, **kwargs)

    Trainer.__init__ = __init__  # type: ignore[method-assign]
    _patched = True
    return True
