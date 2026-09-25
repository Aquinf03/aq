"""Framework autolog — params, metrics, console, artifacts with almost no instrumentation.

Enabled from metrics.begin(); torn down in metrics.end(). Writes into the train folder:

  artifacts/metrics.jsonl   params / steps (via metrics.emit)
  artifacts/console.log     stdout+stderr tee for the run
  artifacts/runs/<id>.json  artifact pointers (via record.write_run)

Hooks installed when available:
  - recipe scalar params (always)
  - sklearn estimator.get_params + post-fit train_loss step
  - Hugging Face TrainerCallback (shared; methods opt in by attaching it)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from protocol.paths import art_dir

_state: dict[str, Any] = {
    "enabled": False,
    "train": None,
    "console_path": None,
    "console_fp": None,
    "stdout": None,
    "stderr": None,
    "artifacts": {},
    "params_logged": False,
}


def enabled() -> bool:
    return bool(_state.get("enabled"))


def artifacts() -> dict[str, str]:
    return dict(_state.get("artifacts") or {})


def install(train: Path, recipe: dict | None = None, **meta: Any) -> None:
    """Start autolog for this metrics session. Idempotent if already on."""
    if _state.get("enabled"):
        finish()
    train = Path(train)
    _state["enabled"] = True
    _state["train"] = train
    _state["artifacts"] = {}
    _state["params_logged"] = False
    _state["_logged_estimators"] = set()
    _open_console(train)
    params = _recipe_params(recipe or {})
    for k, v in meta.items():
        if v is None or k in params or k in ("op",):
            continue
        if isinstance(v, (str, int, float, bool)):
            params[k] = v
    if params:
        log_params(params)


def finish(**extra_arts: Any) -> dict[str, str]:
    """Flush console tee and return collected artifact paths (train-relative)."""
    arts = dict(_state.get("artifacts") or {})
    for k, v in extra_arts.items():
        if v is not None:
            arts[str(k)] = str(v)
    _close_console()
    console = _state.get("console_path")
    if console is not None:
        arts.setdefault("console", str(console))
    out = dict(arts)
    _reset()
    return out


def log_params(params: dict[str, Any]) -> None:
    """Record hyperparameters (recipe + estimator). Safe no-op if metrics idle."""
    from protocol import metrics as aq_metrics

    flat = _jsonable_params(params)
    if not flat:
        return
    aq_metrics.event("params", **flat)
    _state["params_logged"] = True


def log_artifact(key: str, path: str | Path) -> None:
    """Remember an artifact path (train-relative preferred)."""
    if not key:
        return
    _state.setdefault("artifacts", {})[str(key)] = str(path)


def after_estimator(est: Any, payload: dict[str, Any]) -> None:
    """Sklearn / boosting hook: params + one loss step + estimator artifact."""
    if not enabled():
        # Still allow when metrics session is live (framework patch outside aq train).
        from protocol import metrics as aq_metrics

        if aq_metrics.active_run_id() is None:
            return
    from protocol import metrics as aq_metrics

    eid = id(est)
    seen = _state.setdefault("_logged_estimators", set())
    if eid in seen:
        return
    seen.add(eid)

    try:
        raw = est.get_params(deep=False)
    except Exception:
        raw = {}
    tagged = {f"est.{k}": v for k, v in raw.items()}
    if payload.get("sklearn"):
        tagged["est.class"] = payload["sklearn"]
    if payload.get("backend"):
        tagged["est.backend"] = payload["backend"]
    if tagged:
        log_params(tagged)

    tl = payload.get("train_loss")
    if tl is not None:
        try:
            aq_metrics.step(step=0, loss=float(tl))
        except Exception:
            pass

    est_path = payload.get("estimator_path")
    if est_path:
        log_artifact("estimator", est_path)
    weights = payload.get("weights_dir")
    if weights:
        log_artifact("weights_dir", weights)


def hf_trainer_callback():
    """Return a transformers.TrainerCallback that mirrors logs → metrics.step."""
    from protocol import metrics as aq_metrics
    from protocol import grads as aq_grads

    try:
        from transformers import TrainerCallback
    except ImportError as e:
        raise SystemExit("transformers required for HF autolog callback") from e

    class AutologTrainerCallback(TrainerCallback):
        def on_preoptimizer_step(self, args, state, control, **kwargs):
            if not aq_grads.enabled():
                return
            model = kwargs.get("model")
            if model is None:
                return
            step = int(state.global_step) if state.global_step is not None else None
            try:
                aq_grads.maybe_from_model(model, step=step)
            except Exception:
                pass

        def on_log(self, args, state, control, logs=None, **kwargs):
            if not logs or state.global_step is None:
                return
            loss = logs.get("loss")
            if loss is None:
                return
            lr = logs.get("learning_rate")
            fields: dict[str, Any] = {"loss": float(loss)}
            if lr is not None:
                fields["lr"] = float(lr)
            aq_metrics.step(step=int(state.global_step), **fields)

    return AutologTrainerCallback()


def _recipe_params(recipe: dict) -> dict[str, Any]:
    """Flatten recipe scalars (shallow + a few known nested blocks)."""
    out: dict[str, Any] = {}
    skip = {"_train", "data"}  # data path logged on start; avoid huge blobs
    for k, v in recipe.items():
        if k in skip or str(k).startswith("_"):
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[str(k)] = v
        elif isinstance(v, dict) and k in (
            "train",
            "penalty",
            "tree",
            "forest",
            "boosting",
            "transformer",
            "llm",
            "eval",
            "guard",
        ):
            for sk, sv in v.items():
                if isinstance(sv, (str, int, float, bool)) or sv is None:
                    out[f"{k}.{sk}"] = sv
    data = recipe.get("data") or {}
    if isinstance(data, dict):
        for sk in ("path", "target", "text", "src", "tgt"):
            if data.get(sk) is not None and isinstance(data[sk], (str, int, float, bool)):
                out[f"data.{sk}"] = data[sk]
    return out


def _jsonable_params(params: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, (str, int, float, bool)):
            out[str(k)] = v
        elif isinstance(v, Path):
            out[str(k)] = str(v)
        elif isinstance(v, (list, tuple)) and len(v) <= 32 and all(
            isinstance(x, (str, int, float, bool)) for x in v
        ):
            out[str(k)] = list(v)
        else:
            # keep small repr for exotic sklearn params (callables → skip)
            try:
                json.dumps(v)
                out[str(k)] = v
            except (TypeError, ValueError):
                continue
    return out


class _Tee:
    """Write to original stream and a log file."""

    def __init__(self, primary: Any, secondary: Any):
        self._primary = primary
        self._secondary = secondary

    def write(self, data: str) -> int:
        n = self._primary.write(data)
        try:
            self._secondary.write(data)
            self._secondary.flush()
        except Exception:
            pass
        return n

    def flush(self) -> None:
        self._primary.flush()
        try:
            self._secondary.flush()
        except Exception:
            pass

    def fileno(self) -> int:
        return self._primary.fileno()

    def isatty(self) -> bool:
        return bool(getattr(self._primary, "isatty", lambda: False)())

    @property
    def encoding(self) -> str | None:
        return getattr(self._primary, "encoding", None)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._primary, name)


def _open_console(train: Path) -> None:
    art = art_dir(train)
    art.mkdir(parents=True, exist_ok=True)
    path = art / "console.log"
    fp = path.open("a", encoding="utf-8")
    fp.write(f"\n--- run {_iso_stamp()} ---\n")
    fp.flush()
    _state["console_path"] = "artifacts/console.log"
    _state["console_fp"] = fp
    _state["stdout"] = sys.stdout
    _state["stderr"] = sys.stderr
    sys.stdout = _Tee(sys.stdout, fp)  # type: ignore[assignment]
    sys.stderr = _Tee(sys.stderr, fp)  # type: ignore[assignment]


def _close_console() -> None:
    fp = _state.get("console_fp")
    out = _state.get("stdout")
    err = _state.get("stderr")
    if out is not None:
        sys.stdout = out
    if err is not None:
        sys.stderr = err
    if fp is not None:
        try:
            fp.write(f"--- end {_iso_stamp()} ---\n")
            fp.close()
        except Exception:
            pass
    _state["console_fp"] = None
    _state["stdout"] = None
    _state["stderr"] = None


def _iso_stamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _reset() -> None:
    _state["enabled"] = False
    _state["train"] = None
    _state["console_path"] = None
    _state["artifacts"] = {}
    _state["params_logged"] = False
