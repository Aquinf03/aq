"""Classical model evaluation suite — metrics + plots on the run.

    from aquin import evaluate
    evaluate(y_true, y_pred, y_prob=proba, cost=240, fairness=gap)

Extra named kwargs (numbers or callables) land on the same UI as the suite
(``eval.extra``). Optional recipe ``eval.extra: [cost]`` loads ``scorers.py:cost``
for ``aq eval``.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Sequence

# Classification gate metrics that are higher-is-better (extend step.LOWER otherwise).
CLASS_METRICS = ("accuracy", "precision", "recall", "f1", "roc_auc", "pr_auc")
REG_METRICS = ("mae", "mse", "rmse", "r2")


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "on", "1", "suite")


def want(rec: dict | None = None, req: dict | None = None) -> bool:
    """req > env > recipe eval.suite > default on for tabular/classic family."""
    if req is not None:
        if "eval_suite" in req:
            return _truthy(req.get("eval_suite"))
        if "suite" in req and req.get("suite") is not None:
            return _truthy(req.get("suite"))
    for key in ("AQ_EVAL_SUITE", "AQ_SUITE"):
        env = os.environ.get(key, "").strip().lower()
        if env in ("1", "true", "yes", "on"):
            return True
        if env in ("0", "false", "no", "off"):
            return False
    if isinstance(rec, dict):
        ev = rec.get("eval")
        if isinstance(ev, dict) and "suite" in ev:
            return _truthy(ev.get("suite"))
        fam = str(rec.get("family") or "").lower()
        if fam in ("tabular", "classic", "classical", "sklearn"):
            return True
        method = str(rec.get("method") or "").lower()
        if method in (
            "linear",
            "logistic",
            "ridge",
            "lasso",
            "elasticnet",
            "elastic-net",
            "tree",
            "forest",
            "gbm",
            "xgboost",
            "lightgbm",
            "catboost",
            "gp",
            "svm",
            "knn",
        ):
            return True
    return False


def infer_task(
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    *,
    y_prob: Sequence[Any] | None = None,
    task: str | None = None,
) -> str:
    if task:
        t = str(task).strip().lower()
        if t in ("classification", "clf", "class"):
            return "classification"
        if t in ("regression", "reg"):
            return "regression"
    # Heuristic: mostly non-float labels or few unique ints → classification
    try:
        vals = list(y_true)[:500]
        if not vals:
            return "regression"
        as_float = True
        for v in vals:
            if isinstance(v, (bool, str)) and not _looks_number(v):
                as_float = False
                break
            try:
                float(v)
            except (TypeError, ValueError):
                as_float = False
                break
        if not as_float:
            return "classification"
        uniq = { _num(v) for v in vals }
        # small integer label set
        if all(float(u).is_integer() for u in uniq) and len(uniq) <= max(20, int(math.sqrt(len(vals)))):
            if y_prob is not None:
                return "classification"
            # preds also look discrete?
            puniq = {_num(v) for v in list(y_pred)[:500]}
            if all(float(u).is_integer() for u in puniq) and len(puniq) <= 20:
                return "classification"
        return "regression"
    except Exception:
        return "regression"


def _looks_number(v: Any) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _num(v: Any) -> float:
    return float(v)


def compute(
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    *,
    y_prob: Sequence[Any] | None = None,
    task: str | None = None,
    average: str = "macro",
) -> dict[str, Any]:
    """Return suite dict: task, n, metrics…, suite_s compact line."""
    n = min(len(y_true), len(y_pred))
    if n == 0:
        raise SystemExit("evaluate: empty y_true / y_pred")
    yt = list(y_true)[:n]
    yp = list(y_pred)[:n]
    ypr = list(y_prob)[:n] if y_prob is not None else None
    task_name = infer_task(yt, yp, y_prob=ypr, task=task)
    if task_name == "classification":
        body = _class_metrics(yt, yp, ypr, average=average)
    else:
        body = _reg_metrics(yt, yp)
    body["task"] = task_name
    body["n"] = n
    body["suite_s"] = _compact(body)
    return body


def _compact(body: dict[str, Any]) -> str:
    task = body.get("task")
    bits: list[str] = []
    if task == "classification":
        for k, label in (
            ("accuracy", "acc"),
            ("precision", "P"),
            ("recall", "R"),
            ("f1", "F1"),
            ("roc_auc", "auc"),
            ("pr_auc", "prauc"),
        ):
            if body.get(k) is not None:
                bits.append(f"{label}={_fmt(body[k])}")
    else:
        for k in ("mae", "mse", "rmse", "r2"):
            if body.get(k) is not None:
                bits.append(f"{k}={_fmt(body[k])}")
    return "  ".join(bits) if bits else str(task or "suite")


def _fmt(v: Any) -> str:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(x) >= 100 or (abs(x) > 0 and abs(x) < 0.01):
        return f"{x:.3g}"
    return f"{x:.4f}".rstrip("0").rstrip(".")


def _class_metrics(
    y_true: list[Any],
    y_pred: list[Any],
    y_prob: list[Any] | None,
    *,
    average: str,
) -> dict[str, Any]:
    sk = _sklearn()
    yt = [str(v) for v in y_true]
    yp = [str(v) for v in y_pred]
    out: dict[str, Any] = {
        "accuracy": float(sk.metrics.accuracy_score(yt, yp)),
    }
    try:
        out["precision"] = float(
            sk.metrics.precision_score(yt, yp, average=average, zero_division=0)
        )
        out["recall"] = float(sk.metrics.recall_score(yt, yp, average=average, zero_division=0))
        out["f1"] = float(sk.metrics.f1_score(yt, yp, average=average, zero_division=0))
    except Exception:
        pass
    labels = sorted(set(yt) | set(yp))
    out["n_classes"] = len(labels)
    # ROC / PR need scores
    scores = _prob_scores(y_prob, labels)
    if scores is not None:
        try:
            if len(labels) == 2:
                # positive = last label (sklearn convention for binary string labels is fragile;
                # use numeric encoding)
                y_bin = [1 if v == labels[-1] else 0 for v in yt]
                out["roc_auc"] = float(sk.metrics.roc_auc_score(y_bin, scores))
                out["pr_auc"] = float(sk.metrics.average_precision_score(y_bin, scores))
            else:
                # multilabel / multiclass: need (n, n_classes) proba
                if hasattr(scores, "shape") and getattr(scores, "ndim", 1) == 2:
                    out["roc_auc"] = float(
                        sk.metrics.roc_auc_score(yt, scores, multi_class="ovr", average=average)
                    )
        except Exception:
            pass
    return out


def _reg_metrics(y_true: list[Any], y_pred: list[Any]) -> dict[str, Any]:
    sk = _sklearn()
    yt = [float(v) for v in y_true]
    yp = [float(v) for v in y_pred]
    out: dict[str, Any] = {
        "mae": float(sk.metrics.mean_absolute_error(yt, yp)),
        "mse": float(sk.metrics.mean_squared_error(yt, yp)),
    }
    out["rmse"] = float(math.sqrt(out["mse"]))
    try:
        out["r2"] = float(sk.metrics.r2_score(yt, yp))
    except Exception:
        out["r2"] = None
    return out


def _prob_scores(y_prob: list[Any] | None, labels: list[str]) -> Any | None:
    if not y_prob:
        return None
    import numpy as np

    try:
        arr = np.asarray(y_prob, dtype=float)
    except (TypeError, ValueError):
        return None
    if arr.ndim == 1:
        return arr
    if arr.ndim == 2:
        if len(labels) == 2 and arr.shape[1] >= 2:
            return arr[:, -1]
        return arr
    return None


def _sklearn():
    from backends.deps import require_sklearn

    require_sklearn()
    import sklearn
    import sklearn.metrics  # noqa: F401

    return sklearn


def write_plots(
    train: Path,
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    *,
    y_prob: Sequence[Any] | None = None,
    task: str | None = None,
    out_dir: Path | None = None,
    dpi: int = 120,
    prefix: str = "",
) -> list[dict[str, str]]:
    """Write standard charts; return [{kind, path}, …] relative to train when possible."""
    n = min(len(y_true), len(y_pred))
    yt = list(y_true)[:n]
    yp = list(y_pred)[:n]
    ypr = list(y_prob)[:n] if y_prob is not None else None
    task_name = infer_task(yt, yp, y_prob=ypr, task=task)
    from protocol.paths import art_dir

    plots_dir = out_dir or (art_dir(train) / "plots")
    plots_dir.mkdir(parents=True, exist_ok=True)
    # matplotlib config dir for headless
    mpl_dir = art_dir(train) / ".matplotlib"
    mpl_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(mpl_dir))

    written: list[dict[str, str]] = []
    pre = f"{prefix}_" if prefix else ""
    try:
        if task_name == "classification":
            p = _plot_confusion(plots_dir / f"{pre}confusion.png", yt, yp, dpi=dpi)
            if p:
                written.append({"kind": "confusion", "path": _rel(train, p)})
            if ypr is not None:
                p = _plot_roc(plots_dir / f"{pre}roc.png", yt, ypr, dpi=dpi)
                if p:
                    written.append({"kind": "roc", "path": _rel(train, p)})
                p = _plot_pr(plots_dir / f"{pre}pr.png", yt, ypr, dpi=dpi)
                if p:
                    written.append({"kind": "pr", "path": _rel(train, p)})
        else:
            p = _plot_residuals(plots_dir / f"{pre}residuals.png", yt, yp, dpi=dpi)
            if p:
                written.append({"kind": "residuals", "path": _rel(train, p)})
            p = _plot_pred_vs_true(plots_dir / f"{pre}pred_vs_true.png", yt, yp, dpi=dpi)
            if p:
                written.append({"kind": "pred", "path": _rel(train, p)})
    except Exception:
        pass
    return written


def _rel(train: Path, path: Path) -> str:
    try:
        return str(path.relative_to(train))
    except ValueError:
        return str(path)


def run(
    train: Path,
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    *,
    y_prob: Sequence[Any] | None = None,
    task: str | None = None,
    average: str = "macro",
    path: str | None = None,
    plots: bool = True,
    dpi: int = 120,
    prefix: str = "",
    emit: bool = True,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute suite, write plots, emit metrics events. Returns suite body.

    ``extras`` — named org scores (float or ``fn(y_true, y_pred)``), same UI as suite.
    """
    from protocol import metrics as aq_metrics

    body = compute(y_true, y_pred, y_prob=y_prob, task=task, average=average)
    if path:
        body["path"] = path
    plot_rows: list[dict[str, str]] = []
    if plots:
        plot_rows = write_plots(
            train,
            y_true,
            y_pred,
            y_prob=y_prob,
            task=body.get("task"),
            dpi=dpi,
            prefix=prefix,
        )
        if plot_rows:
            body["plots"] = [r["kind"] for r in plot_rows]
    extra_rows = resolve_extras(extras or {}, y_true, y_pred, y_prob=y_prob)
    if extra_rows:
        body["extra"] = {r["key"]: r.get("score") for r in extra_rows if "score" in r}
        body["extra_s"] = compact_extras(extra_rows)
    if emit:
        # Drop non-json-friendly / huge fields — metrics only
        event_body = {
            k: v
            for k, v in body.items()
            if k not in ("y_true", "y_pred", "y_prob", "extra") and v is not None
        }
        aq_metrics.event("eval.suite", **event_body)
        for row in plot_rows:
            aq_metrics.event("eval.plot", kind=row["kind"], path=row["path"], path_probe=path)
        for row in extra_rows:
            # use emit — metrics.event(name=...) would clash with a "name" field
            aq_metrics.emit("eval.extra", path=path, **row)
    body["_plots"] = plot_rows
    body["_extras"] = extra_rows
    return body


_RESERVED_EXTRA = frozenset(
    {
        "train",
        "task",
        "average",
        "plots",
        "path",
        "emit",
        "dpi",
        "prefix",
        "y_true",
        "y_pred",
        "y_prob",
        "extras",
    }
)


def resolve_extras(
    extras: dict[str, Any],
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    *,
    y_prob: Sequence[Any] | None = None,
) -> list[dict[str, Any]]:
    """Turn kwargs / recipe extras into emit-ready rows.

    Value may be a number, a ``dict`` of numbers, or ``callable(y_true, y_pred[, y_prob])``.
    """
    rows: list[dict[str, Any]] = []
    for name, raw in extras.items():
        if name in _RESERVED_EXTRA or raw is None:
            continue
        name = str(name)
        try:
            val = _call_extra(raw, y_true, y_pred, y_prob)
        except Exception as e:
            rows.append({"key": name, "error": str(e)[:200]})
            continue
        if isinstance(val, dict):
            # Primary score = first numeric, rest as fields
            fields = {str(k): _as_float(v) for k, v in val.items() if _as_float(v) is not None}
            if not fields:
                continue
            score = fields.get("score")
            if score is None:
                score = next(iter(fields.values()))
            row = {"key": name, "score": score, **{k: v for k, v in fields.items() if k != "score"}}
            rows.append(row)
        else:
            num = _as_float(val)
            if num is None:
                continue
            rows.append({"key": name, "score": num})
    return rows


def compact_extras(rows: list[dict[str, Any]]) -> str:
    bits: list[str] = []
    for r in rows:
        name = r.get("key") or "extra"
        if r.get("error"):
            bits.append(f"{name}=err")
            continue
        if r.get("score") is not None:
            bits.append(f"{name}={_fmt(r['score'])}")
    return "  ".join(bits)


def _call_extra(
    raw: Any,
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    y_prob: Sequence[Any] | None,
) -> Any:
    if not callable(raw):
        return raw
    try:
        return raw(y_true, y_pred, y_prob)
    except TypeError:
        return raw(y_true, y_pred)


def _as_float(v: Any) -> float | None:
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def recipe_extras(train: Path, rec: dict) -> dict[str, Any]:
    """Optional CI glue: ``eval.extra: [cost]`` → load ``scorers.py:cost`` (or ``path:fn``)."""
    ev = rec.get("eval") if isinstance(rec, dict) else None
    if not isinstance(ev, dict) or "extra" not in ev:
        return {}
    raw = ev.get("extra")
    names: list[str] = []
    if isinstance(raw, str):
        names = [raw]
    elif isinstance(raw, list):
        names = [str(x) for x in raw if x]
    elif isinstance(raw, dict):
        # {cost: scorers:cost} or {cost: true} → scorers.cost
        out: dict[str, Any] = {}
        for k, v in raw.items():
            if v is True or v is None or v == "":
                fn = load_scorer(train, str(k))
            else:
                fn = load_scorer(train, str(v) if ":" in str(v) or "/" in str(v) else f"scorers:{v}")
                if fn is None:
                    fn = load_scorer(train, str(k))
            if fn is not None:
                out[str(k)] = fn
        return out
    else:
        return {}
    out = {}
    for spec in names:
        fn = load_scorer(train, spec)
        if fn is None:
            continue
        # name = function name after :
        key = spec.split(":")[-1].split(".")[-1] if ":" in spec else spec
        out[key] = fn
    return out


def load_scorer(train: Path, spec: str):
    """Load ``scorers:cost``, ``scorers.py:cost``, or ``tools/fair.py:gap``."""
    import importlib.util

    spec = str(spec).strip()
    if not spec:
        return None
    if ":" in spec:
        mod_part, fn_name = spec.rsplit(":", 1)
    else:
        mod_part, fn_name = "scorers", spec
    mod_part = mod_part.strip().removesuffix(".py")
    fn_name = fn_name.strip()
    # path relative to train
    candidates = [
        train / f"{mod_part}.py",
        train / mod_part if mod_part.endswith(".py") else train / f"{mod_part.replace('.', '/')}.py",
    ]
    if mod_part == "scorers":
        candidates.insert(0, train / "scorers.py")
    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        return None
    try:
        uid = f"aq_scorer_{path.stem}_{fn_name}"
        um = importlib.util.spec_from_file_location(uid, path)
        if um is None or um.loader is None:
            return None
        mod = importlib.util.module_from_spec(um)
        um.loader.exec_module(mod)
        fn = getattr(mod, fn_name, None)
        return fn if callable(fn) else None
    except Exception:
        return None


def predict_arrays(
    train: Path,
    rec: dict,
    model: dict,
    src: Path,
) -> dict[str, Any] | None:
    """Best-effort y_true / y_pred / y_prob for a probe file. None if unsupported."""
    target = (rec.get("data") or {}).get("target")
    if not target:
        return None
    try:
        from backends.sklearn_tab import load_xy
        from protocol.method import load_method
    except Exception:
        return None
    kind = str(model.get("kind") or rec.get("method") or "linear")
    try:
        mod = load_method(train, kind)
    except Exception:
        return None
    try:
        feats, X, y = load_xy(src, str(target))
    except Exception:
        return None
    if model.get("features") and list(model["features"]) != list(feats):
        return None
    rec2 = {**rec, "_train": str(train.resolve())}
    # Prefer estimator for proba
    y_prob = None
    path = model.get("estimator_path")
    if path:
        try:
            import joblib

            est = joblib.load(Path(train) / path)
            y_pred = est.predict(X).tolist()
            if hasattr(est, "predict_proba"):
                try:
                    y_prob = est.predict_proba(X).tolist()
                except Exception:
                    y_prob = None
            return {"y_true": list(y), "y_pred": list(y_pred), "y_prob": y_prob}
        except Exception:
            pass
    if not hasattr(mod, "predict"):
        return None
    try:
        y_pred = mod.predict(model, X)
        if hasattr(y_pred, "tolist"):
            y_pred = y_pred.tolist()
        return {"y_true": list(y), "y_pred": list(y_pred), "y_prob": None}
    except Exception:
        return None


# --- matplotlib charts ---------------------------------------------------------


def _plot_confusion(path: Path, y_true: list, y_pred: list, *, dpi: int) -> Path | None:
    from plot.render import apply_theme, save_fig
    import matplotlib.pyplot as plt

    sk = _sklearn()
    yt = [str(v) for v in y_true]
    yp = [str(v) for v in y_pred]
    labels = sorted(set(yt) | set(yp))
    cm = sk.metrics.confusion_matrix(yt, yp, labels=labels)
    apply_theme()
    fig, ax = plt.subplots(figsize=(max(4, 0.6 * len(labels) + 2), max(3.5, 0.6 * len(labels) + 2)))
    im = ax.imshow(cm, cmap="Blues")
    ax.set_xticks(range(len(labels)))
    ax.set_yticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.set_yticklabels(labels)
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    ax.set_title("confusion matrix")
    for i in range(cm.shape[0]):
        for j in range(cm.shape[1]):
            ax.text(j, i, str(cm[i, j]), ha="center", va="center", color="black", fontsize=8)
    fig.colorbar(im, ax=ax, fraction=0.046)
    save_fig(path, dpi=dpi)
    return path


def _binary_scores(y_true: list, y_prob: list) -> tuple[list[int], Any] | None:
    import numpy as np

    yt = [str(v) for v in y_true]
    labels = sorted(set(yt))
    if len(labels) != 2:
        return None
    pos = labels[-1]
    y_bin = [1 if v == pos else 0 for v in yt]
    arr = np.asarray(y_prob, dtype=float)
    if arr.ndim == 2 and arr.shape[1] >= 2:
        scores = arr[:, -1]
    elif arr.ndim == 1:
        scores = arr
    else:
        return None
    return y_bin, scores


def _plot_roc(path: Path, y_true: list, y_prob: list, *, dpi: int) -> Path | None:
    pair = _binary_scores(y_true, y_prob)
    if pair is None:
        return None
    y_bin, scores = pair
    sk = _sklearn()
    fpr, tpr, _ = sk.metrics.roc_curve(y_bin, scores)
    auc = float(sk.metrics.auc(fpr, tpr))
    from plot.render import apply_theme, save_fig
    import matplotlib.pyplot as plt

    apply_theme()
    fig, ax = plt.subplots(figsize=(5, 4))
    ax.plot(fpr, tpr, color="#2563eb", label=f"AUC={auc:.3f}")
    ax.plot([0, 1], [0, 1], color="#999999", linestyle="--", linewidth=1)
    ax.set_xlabel("FPR")
    ax.set_ylabel("TPR")
    ax.set_title("ROC")
    ax.legend(loc="lower right")
    ax.grid(True)
    save_fig(path, dpi=dpi)
    return path


def _plot_pr(path: Path, y_true: list, y_prob: list, *, dpi: int) -> Path | None:
    pair = _binary_scores(y_true, y_prob)
    if pair is None:
        return None
    y_bin, scores = pair
    sk = _sklearn()
    prec, rec, _ = sk.metrics.precision_recall_curve(y_bin, scores)
    ap = float(sk.metrics.average_precision_score(y_bin, scores))
    from plot.render import apply_theme, save_fig
    import matplotlib.pyplot as plt

    apply_theme()
    fig, ax = plt.subplots(figsize=(5, 4))
    ax.plot(rec, prec, color="#16a34a", label=f"AP={ap:.3f}")
    ax.set_xlabel("recall")
    ax.set_ylabel("precision")
    ax.set_title("precision–recall")
    ax.legend(loc="lower left")
    ax.grid(True)
    save_fig(path, dpi=dpi)
    return path


def _plot_residuals(path: Path, y_true: list, y_pred: list, *, dpi: int) -> Path | None:
    from plot.render import apply_theme, save_fig
    import matplotlib.pyplot as plt

    yt = [float(v) for v in y_true]
    yp = [float(v) for v in y_pred]
    resid = [yt[i] - yp[i] for i in range(len(yt))]
    apply_theme()
    fig, ax = plt.subplots(figsize=(5.5, 4))
    ax.scatter(yp, resid, s=12, color="#2563eb", alpha=0.75)
    ax.axhline(0, color="#999999", linestyle="--", linewidth=1)
    ax.set_xlabel("predicted")
    ax.set_ylabel("residual (true − pred)")
    ax.set_title("residuals")
    ax.grid(True)
    save_fig(path, dpi=dpi)
    return path


def _plot_pred_vs_true(path: Path, y_true: list, y_pred: list, *, dpi: int) -> Path | None:
    from plot.render import apply_theme, save_fig
    import matplotlib.pyplot as plt

    yt = [float(v) for v in y_true]
    yp = [float(v) for v in y_pred]
    apply_theme()
    fig, ax = plt.subplots(figsize=(5.5, 4))
    ax.scatter(yt, yp, s=12, color="#2563eb", alpha=0.75)
    lo = min(min(yt), min(yp))
    hi = max(max(yt), max(yp))
    ax.plot([lo, hi], [lo, hi], color="#999999", linestyle="--", linewidth=1)
    ax.set_xlabel("true")
    ax.set_ylabel("predicted")
    ax.set_title("pred vs true")
    ax.grid(True)
    save_fig(path, dpi=dpi)
    return path
