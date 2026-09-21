"""LightGBM — record_evaluation callback → metrics.step."""

from __future__ import annotations

_orig_fit = None
_patched = False


def apply(*, disable: bool = False) -> bool:
    global _orig_fit, _patched
    try:
        import lightgbm as lgb
        from lightgbm import LGBMModel
    except ImportError:
        return False

    if disable:
        if _patched and _orig_fit is not None:
            LGBMModel.fit = _orig_fit  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    _orig_fit = LGBMModel.fit

    def fit(self, *args, **kwargs):  # noqa: ANN001
        evals: dict = {}

        def _cb(env):  # noqa: ANN001
            try:
                from protocol import metrics as aq_metrics

                loss = None
                for _data_name, eval_name, value, _ in getattr(env, "evaluation_result_list", []) or []:
                    if eval_name in ("l2", "rmse", "binary_logloss", "multi_logloss", "mae"):
                        loss = float(value)
                        break
                if loss is not None:
                    aq_metrics.step(step=int(env.iteration), loss=loss)
            except Exception:
                pass

        cbs = list(kwargs.get("callbacks") or [])
        cbs.append(_cb)
        # keep evals for after_estimator if user passed eval_set
        kwargs["callbacks"] = cbs
        out = _orig_fit(self, *args, **kwargs)
        try:
            from protocol import autolog

            autolog.after_estimator(self, {"sklearn": type(self).__name__, "backend": "lightgbm"})
        except Exception:
            pass
        return out

    LGBMModel.fit = fit  # type: ignore[method-assign]
    _patched = True
    return True
