"""sklearn — wrap estimator.fit on BaseEstimator subclasses → aq params + loss."""

from __future__ import annotations

from typing import Any, Callable

_patched_classes: set[int] = set()
_orig_init_subclass = None
_hooked = False


def apply(*, disable: bool = False) -> bool:
    global _orig_init_subclass, _hooked
    try:
        from sklearn.base import BaseEstimator
    except ImportError:
        return False

    if disable:
        # Best-effort: cannot easily restore every wrapped fit; leave wrappers
        # (they no-op without an active metrics session).
        _hooked = False
        return True

    if _hooked:
        return True

    # Import common estimator modules so subclasses exist, then wrap .fit.
    for mod in (
        "sklearn.linear_model",
        "sklearn.tree",
        "sklearn.ensemble",
        "sklearn.svm",
        "sklearn.neighbors",
        "sklearn.naive_bayes",
        "sklearn.gaussian_process",
        "sklearn.neural_network",
        "sklearn.pipeline",
        "sklearn.compose",
        "sklearn.multiclass",
        "sklearn.semi_supervised",
        "sklearn.discriminant_analysis",
        "sklearn.kernel_ridge",
        "sklearn.isotonic",
        "sklearn.cross_decomposition",
    ):
        try:
            __import__(mod)
        except Exception:
            pass

    _patch_existing(BaseEstimator)
    if _orig_init_subclass is None:
        _orig_init_subclass = getattr(BaseEstimator, "__init_subclass__", classmethod(lambda cls, **k: None))

        @classmethod
        def __init_subclass__(cls, **kwargs):  # noqa: ANN001
            if _orig_init_subclass is not None:
                try:
                    _orig_init_subclass.__func__(cls, **kwargs)  # type: ignore[attr-defined]
                except TypeError:
                    try:
                        _orig_init_subclass(cls, **kwargs)  # type: ignore[misc]
                    except Exception:
                        pass
            _wrap_fit(cls)

        BaseEstimator.__init_subclass__ = __init_subclass__  # type: ignore[method-assign]

    _hooked = True
    return True


def _all_subclasses(cls: type) -> list[type]:
    out: list[type] = []
    for sub in cls.__subclasses__():
        out.append(sub)
        out.extend(_all_subclasses(sub))
    return out


def _patch_existing(base: type) -> None:
    for cls in _all_subclasses(base):
        _wrap_fit(cls)


def _wrap_fit(cls: type) -> None:
    if id(cls) in _patched_classes:
        return
    fit = cls.__dict__.get("fit")
    if fit is None or not callable(fit):
        return
    if getattr(fit, "_aq_wrapped", False):
        return

    orig: Callable[..., Any] = fit

    def fit_wrapped(self, *args, **kwargs):  # noqa: ANN001
        out = orig(self, *args, **kwargs)
        X = args[0] if args else kwargs.get("X")
        y = args[1] if len(args) > 1 else kwargs.get("y")
        _after(self, X, y)
        return out

    fit_wrapped._aq_wrapped = True  # type: ignore[attr-defined]
    try:
        cls.fit = fit_wrapped  # type: ignore[method-assign]
        _patched_classes.add(id(cls))
    except Exception:
        pass


def _after(est: Any, X: Any, y: Any) -> None:
    try:
        from protocol import metrics as aq_metrics
        from protocol import autolog

        if aq_metrics.active_run_id() is None and not autolog.enabled():
            return
        payload: dict[str, Any] = {
            "sklearn": type(est).__name__,
            "backend": "sklearn",
        }
        if y is not None and X is not None and hasattr(est, "predict"):
            try:
                import numpy as np

                pred = est.predict(X)
                yt = np.asarray(y, dtype=float).ravel()
                yh = np.asarray(pred, dtype=float).ravel()
                if yt.shape == yh.shape and yt.size:
                    payload["train_loss"] = float(np.mean((yt - yh) ** 2))
            except Exception:
                pass
        autolog.after_estimator(est, payload)
    except Exception:
        pass
