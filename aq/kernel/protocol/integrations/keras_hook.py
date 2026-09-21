"""Keras / TensorFlow — Callback → metrics.step."""

from __future__ import annotations

_orig_fit = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_fit, _patched
    Model = None
    try:
        from keras import Model  # type: ignore
    except ImportError:
        try:
            from tensorflow.keras import Model  # type: ignore
        except ImportError:
            return False

    if disable:
        if _patched and _orig_fit is not None:
            Model.fit = _orig_fit  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    try:
        from keras.callbacks import Callback
    except ImportError:
        from tensorflow.keras.callbacks import Callback  # type: ignore

    _orig_fit = Model.fit

    class AqCallback(Callback):
        def on_epoch_end(self, epoch, logs=None):  # noqa: ANN001
            logs = logs or {}
            try:
                from protocol import metrics as aq_metrics

                loss = logs.get("loss")
                if loss is not None:
                    aq_metrics.step(
                        step=int(epoch),
                        loss=float(loss),
                        acc=logs.get("accuracy") or logs.get("acc"),
                        val_loss=logs.get("val_loss"),
                        val_acc=logs.get("val_accuracy") or logs.get("val_acc"),
                    )
            except Exception:
                pass

    def fit(self, *args, **kwargs):  # noqa: ANN001
        cbs = list(kwargs.get("callbacks") or [])
        if not any(type(c).__name__ == "AqCallback" for c in cbs):
            cbs.append(AqCallback())
            kwargs["callbacks"] = cbs
        return _orig_fit(self, *args, **kwargs)

    Model.fit = fit  # type: ignore[method-assign]
    _patched = True
    return True
