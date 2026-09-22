"""Spark ML — patch pyspark.ml.Estimator.fit → aq params (+ optional train metric)."""

from __future__ import annotations

from typing import Any

_orig_fit = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_fit, _patched
    try:
        from pyspark.ml import Estimator
    except ImportError:
        return False

    if disable:
        if _patched and _orig_fit is not None:
            Estimator.fit = _orig_fit  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    _orig_fit = Estimator.fit

    def fit(self, dataset, params=None):  # noqa: ANN001
        out = _orig_fit(self, dataset, params)
        _after(self, out)
        return out

    Estimator.fit = fit  # type: ignore[method-assign]
    _patched = True
    return True


def _after(est: Any, model: Any) -> None:
    try:
        from protocol import metrics as aq_metrics
        from protocol import autolog

        if aq_metrics.active_run_id() is None and not autolog.enabled():
            return
        params: dict[str, Any] = {
            "est.class": type(est).__name__,
            "est.backend": "spark",
        }
        try:
            # Spark ParamMap → flat scalars where possible
            raw = est.extractParamMap() if hasattr(est, "extractParamMap") else {}
            for p, v in (raw or {}).items():
                name = getattr(p, "name", str(p))
                if isinstance(v, (str, int, float, bool)) or v is None:
                    params[f"est.{name}"] = v
        except Exception:
            pass
        autolog.log_params(params)
        # Classification/regression models sometimes expose summary metrics
        try:
            summary = getattr(model, "summary", None)
            loss = None
            if summary is not None:
                for attr in ("objectiveHistory", "loss", "meanSquaredError", "rootMeanSquaredError"):
                    val = getattr(summary, attr, None)
                    if val is None:
                        continue
                    if isinstance(val, (list, tuple)) and val:
                        loss = float(val[-1])
                        break
                    try:
                        loss = float(val)
                        break
                    except (TypeError, ValueError):
                        continue
            if loss is not None:
                aq_metrics.step(step=0, loss=loss)
        except Exception:
            pass
    except Exception:
        pass
