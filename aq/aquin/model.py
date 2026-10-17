"""Simple model load + predict.

    from aquin import load
    model = load("artifacts/checkpoints/last.json")  # or last / sha256:…
    y = model.predict(x)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aquin.bridge import _ensure_kernel_path
from aquin.handle import find_kernel, open_run


def _as_rows(x: Any) -> list:
    """Normalize x into a list of rows for method.predict(model, X)."""
    if x is None:
        raise ValueError("predict(x) needs input")
    # numpy / torch
    if hasattr(x, "tolist") and not isinstance(x, (list, tuple, dict, str)):
        x = x.tolist()
    if isinstance(x, dict):
        # feature name → value (one row)
        return [x]
    if isinstance(x, (list, tuple)):
        if not x:
            return []
        first = x[0]
        # list of rows
        if isinstance(first, (list, tuple, dict)):
            return list(x)
        # single row of scalars
        if isinstance(first, (int, float, str, bool)) or first is None:
            return [list(x)]
        return list(x)
    raise TypeError(f"predict() expected rows or a single row, got {type(x).__name__}")


def _find_train(train: str | Path | None) -> Path:
    if train is not None:
        return open_run(train).root
    # cwd train, else walk up for recipe.yaml
    here = Path.cwd().resolve()
    for p in [here, *here.parents]:
        if (p / "recipe.yaml").is_file():
            return p
        if len(p.parts) <= 2:
            break
    return here


def _resolve_checkpoint(train: Path, ref: str | Path) -> Path:
    """Resolve last / path / aq_model_id → checkpoint JSON path."""
    from protocol.paths import ckpt_dir

    raw = str(ref).strip()
    root = train.resolve()
    ckpts = ckpt_dir(root)

    if raw in ("", "last", "latest"):
        last = ckpts / "last.json"
        if last.is_file():
            return last
        raise FileNotFoundError(f"no checkpoint at {last}")

    p = Path(raw)
    if not p.is_absolute():
        p = (root / p).resolve()
    if p.is_file():
        return p
    if p.suffix != ".json" and (p.with_suffix(".json")).is_file():
        return p.with_suffix(".json")
    # numeric step: artifacts/checkpoints/3.json
    if raw.isdigit():
        cand = ckpts / f"{raw}.json"
        if cand.is_file():
            return cand

    # content-addressed id (sha256:…)
    if raw.startswith("sha256:") or len(raw) >= 16:
        want = raw if raw.startswith("sha256:") else None
        for j in sorted(ckpts.glob("*.json")):
            if j.name == "last.json":
                continue
            try:
                data = json.loads(j.read_text(encoding="utf-8"))
            except Exception:
                continue
            mid = data.get("aq_model_id")
            if mid == raw or (want and mid == want) or (mid and mid.endswith(raw)):
                return j
        raise FileNotFoundError(f"no checkpoint with id {raw!r} under {ckpts}")

    raise FileNotFoundError(f"checkpoint not found: {raw}")


class Model:
    """Loaded checkpoint with a boring ``predict(x)``."""

    def __init__(
        self,
        *,
        train: Path,
        checkpoint: Path,
        payload: dict[str, Any],
        recipe: dict[str, Any],
        method: Any,
    ):
        self.train = train
        self.checkpoint = checkpoint
        self.payload = payload
        self.recipe = recipe
        self._method = method
        self.id = payload.get("aq_model_id")
        self.kind = str(payload.get("kind") or recipe.get("method") or "")

    def __repr__(self) -> str:
        mid = self.id or self.checkpoint.name
        return f"Model(kind={self.kind!r}, id={mid!r})"

    def predict(self, x: Any) -> Any:
        """``y = model.predict(x)`` — same call for every method that supports it."""
        if not hasattr(self._method, "predict"):
            raise TypeError(
                f"method {self.kind!r} has no predict(); try aq serve / generate for that stack"
            )
        rows = _as_rows(x)
        # dict rows → feature order from checkpoint when possible
        feats = self.payload.get("features")
        if feats and rows and isinstance(rows[0], dict):
            rows = [[float(r.get(f)) for f in feats] for r in rows]

        # Prefer framework-native estimator when present (sklearn joblib, …)
        est_path = self.payload.get("estimator_path")
        if est_path:
            try:
                import joblib

                est = joblib.load(self.train / str(est_path))
                out = est.predict(rows)
                if hasattr(out, "tolist"):
                    out = out.tolist()
                else:
                    out = list(out)
                return self._unwrap(x, out)
            except Exception:
                pass

        out = self._method.predict(self.payload, rows)
        if hasattr(out, "tolist"):
            out = out.tolist()
        return self._unwrap(x, out)

    @staticmethod
    def _unwrap(x: Any, out: Any) -> Any:
        """Single-row in → single prediction out."""
        if isinstance(out, list) and len(out) == 1:
            if isinstance(x, dict):
                return out[0]
            if (
                isinstance(x, (list, tuple))
                and x
                and not isinstance(x[0], (list, tuple, dict))
            ):
                return out[0]
        return out

    def generate(self, prompt: str = "", **kw: Any) -> Any:
        """Text/serve path when the method has ``generate`` (LLM / tabular row serve)."""
        if not hasattr(self._method, "generate"):
            raise TypeError(f"method {self.kind!r} has no generate()")
        rec = {**self.recipe, "_train": str(self.train.resolve())}
        return self._method.generate(self.payload, prompt, rec, **kw)

    def lineage(self) -> dict[str, Any]:
        """Model → run → data paper trail for this checkpoint."""
        from aquin.lineage import lineage as _lineage

        ref = self.id or str(self.checkpoint)
        return _lineage(ref, train=self.train)


def load(
    path_or_id: str | Path = "last",
    *,
    train: str | Path | None = None,
) -> Model:
    """Load a checkpoint for ``model.predict(x)``.

    ``path_or_id``:
      - ``\"last\"`` / ``\"latest\"`` → ``artifacts/checkpoints/last.json``
      - relative/absolute path to a checkpoint JSON
      - step number (``\"3\"`` → ``…/3.json``)
      - ``aq_model_id`` (``sha256:…``)
    """
    kernel = find_kernel()
    _ensure_kernel_path(kernel)

    from protocol.method import load_method
    from protocol.recipe import load_recipe

    root = _find_train(train)
    ckpt = _resolve_checkpoint(root, path_or_id)
    payload = json.loads(ckpt.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"checkpoint is not an object: {ckpt}")
    rec = load_recipe(root)
    kind = str(payload.get("kind") or rec.get("method") or "")
    if not kind:
        raise ValueError(f"checkpoint has no kind/method: {ckpt}")
    mod = load_method(root, kind)
    # Ensure estimator paths resolve under train
    rec = {**rec, "_train": str(root.resolve())}
    return Model(train=root, checkpoint=ckpt, payload=payload, recipe=rec, method=mod)
