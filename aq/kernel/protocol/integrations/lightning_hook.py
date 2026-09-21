"""PyTorch Lightning — AQ Logger → metrics.step / params."""

from __future__ import annotations

_patched = False
_orig_init = None


def apply(*, disable: bool = False) -> bool:
    global _patched, _orig_init
    try:
        from lightning.pytorch.loggers.logger import Logger
        from lightning.pytorch.trainer.trainer import Trainer
    except ImportError:
        try:
            from pytorch_lightning.loggers.logger import Logger  # type: ignore
            from pytorch_lightning.trainer.trainer import Trainer  # type: ignore
        except ImportError:
            return False

    if disable:
        if _patched and _orig_init is not None:
            Trainer.__init__ = _orig_init  # type: ignore[method-assign]
            _patched = False
        return True

    if _patched:
        return True

    class AqLightningLogger(Logger):
        @property
        def name(self) -> str:
            return "aquin"

        @property
        def version(self) -> str:
            return "0"

        def log_hyperparams(self, params):  # noqa: ANN001
            try:
                from protocol import autolog

                if isinstance(params, dict):
                    autolog.log_params({f"pl.{k}": v for k, v in params.items()})
            except Exception:
                pass

        def log_metrics(self, metrics, step=None):  # noqa: ANN001
            try:
                from protocol import metrics as aq_metrics

                loss = None
                for k in ("loss", "train_loss", "train/loss"):
                    if k in metrics:
                        loss = float(metrics[k])
                        break
                if loss is None:
                    for k, v in metrics.items():
                        if "loss" in str(k).lower():
                            try:
                                loss = float(v)
                                break
                            except (TypeError, ValueError):
                                continue
                if loss is not None:
                    aq_metrics.step(step=int(step or 0), loss=loss)
            except Exception:
                pass

        def save(self) -> None:
            return None

        def finalize(self, status: str) -> None:
            return None

    _orig_init = Trainer.__init__

    def __init__(self, *args, **kwargs):  # noqa: ANN001
        loggers = kwargs.get("logger")
        aq = AqLightningLogger()
        if loggers is False or loggers is None:
            kwargs["logger"] = aq
        elif isinstance(loggers, list):
            if not any(type(x).__name__ == "AqLightningLogger" for x in loggers):
                kwargs["logger"] = list(loggers) + [aq]
        else:
            kwargs["logger"] = [loggers, aq]
        return _orig_init(self, *args, **kwargs)

    Trainer.__init__ = __init__  # type: ignore[method-assign]
    _patched = True
    return True
