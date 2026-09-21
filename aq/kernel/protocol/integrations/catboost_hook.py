"""CatBoost — metrics on each iteration via custom metric printer."""

from __future__ import annotations

_orig_fit = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_fit, _patched
    try:
        from catboost import CatBoost
    except ImportError:
        return False

    if disable:
        if _patched and _orig_fit is not None:
            CatBoost.fit = _orig_fit  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    _orig_fit = CatBoost.fit

    class _AqMeter:
        def after_iteration(self, info):  # noqa: ANN001
            try:
                from protocol import metrics as aq_metrics

                # info has metrics dict on newer catboost
                loss = None
                metrics = getattr(info, "metrics", None) or {}
                for key in ("RMSE", "Logloss", "MAE", "MultiClass"):
                    if key in metrics:
                        vals = metrics[key]
                        if vals:
                            loss = float(vals[-1] if isinstance(vals, (list, tuple)) else vals)
                            break
                it = int(getattr(info, "iteration", 0) or 0)
                if loss is not None:
                    aq_metrics.step(step=it, loss=loss)
            except Exception:
                return True
            return True  # continue training

    def fit(self, *args, **kwargs):  # noqa: ANN001
        # Prefer logging via verbose metric; fall back to after_estimator only.
        out = _orig_fit(self, *args, **kwargs)
        try:
            from protocol import autolog

            payload = {"sklearn": type(self).__name__, "backend": "catboost"}
            # best_score_ / get_best_score when available
            try:
                bs = self.get_best_score()
                if isinstance(bs, dict):
                    for part in bs.values():
                        if isinstance(part, dict):
                            for k, v in part.items():
                                if k.lower() in ("rmse", "logloss", "mae", "loss"):
                                    payload["train_loss"] = float(v)
                                    break
            except Exception:
                pass
            autolog.after_estimator(self, payload)
        except Exception:
            pass
        return out

    CatBoost.fit = fit  # type: ignore[method-assign]
    _patched = True
    return True
