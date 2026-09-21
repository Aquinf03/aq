"""XGBoost — TrainingCallback → metrics.step."""

from __future__ import annotations

_orig_fit = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_fit, _patched
    try:
        import xgboost as xgb
        from xgboost import XGBModel
    except ImportError:
        return False

    if disable:
        if _patched and _orig_fit is not None:
            XGBModel.fit = _orig_fit  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    _orig_fit = XGBModel.fit

    class _AqCb(xgb.callback.TrainingCallback):
        def after_iteration(self, model, epoch, evals_log):  # noqa: ANN001
            try:
                from protocol import metrics as aq_metrics

                loss = None
                if evals_log:
                    # evals_log: {data_name: {metric: [values…]}}
                    for metrics in evals_log.values():
                        for key in ("rmse", "logloss", "error", "mae", "auc"):
                            if key in metrics and metrics[key]:
                                loss = float(metrics[key][-1])
                                break
                        if loss is not None:
                            break
                if loss is None:
                    return
                aq_metrics.step(step=int(epoch), loss=loss)
            except Exception:
                pass

    def fit(self, *args, **kwargs):  # noqa: ANN001
        cbs = list(kwargs.get("callbacks") or [])
        if not any(type(c).__name__ == "_AqCb" for c in cbs):
            cbs.append(_AqCb())
            kwargs["callbacks"] = cbs
        out = _orig_fit(self, *args, **kwargs)
        try:
            from protocol import autolog

            payload = {"sklearn": type(self).__name__, "backend": "xgboost"}
            autolog.after_estimator(self, payload)
        except Exception:
            pass
        return out

    XGBModel.fit = fit  # type: ignore[method-assign]
    _patched = True
    return True
