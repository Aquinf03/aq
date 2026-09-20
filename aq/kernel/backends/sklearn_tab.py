"""Real tabular fit via scikit-learn / XGBoost / LightGBM. Recipe-only."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import csv
import json
from pathlib import Path
from typing import Any

from backends.deps import require_sklearn
from backends.recipe_opt import opt


def _rows(path: Path) -> list[dict]:
    if path.suffix == ".jsonl":
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _num(s: Any):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def load_xy(path: Path, target: str) -> tuple[list[str], list[list[float]], list]:
    rows = _rows(path)
    if not rows:
        raise SystemExit(f"empty data: {path}")
    if target not in rows[0]:
        raise SystemExit(f"target {target!r} not in data")
    feats = [
        k
        for k in rows[0]
        if k != target and all(_num(r.get(k)) is not None for r in rows)
    ]
    if not feats:
        raise SystemExit("no numeric feature columns")
    X = [[float(r[k]) for k in feats] for r in rows]
    y = [r[target] for r in rows]
    return feats, X, y


def _y_float(y: list) -> list[float]:
    out = []
    for v in y:
        n = _num(v)
        if n is None:
            raise SystemExit("expected numeric target")
        out.append(n)
    return out


def _mse(y, pred) -> float:
    n = len(y)
    return float(sum((float(y[i]) - float(pred[i])) ** 2 for i in range(n)) / n)


def _reg_out(kind: str, feats: list[str], est, y, X) -> dict:
    return {
        "kind": kind,
        "backend": "sklearn",
        "task": "regression",
        "features": feats,
        "weights": est.coef_.tolist(),
        "bias": float(est.intercept_),
        "train_loss": _mse(y, est.predict(X)),
        "sklearn": type(est).__name__,
    }


def _persist(est, payload: dict, rec: dict) -> dict:
    train = rec.get("_train")
    if train:
        try:
            import joblib
        except ImportError:
            joblib = None
        if joblib is not None:
            root = Path(train)
            dest = ckpt_dir(root)
            dest.mkdir(parents=True, exist_ok=True)
            n = 1 + sum(1 for p in dest.glob("*.json") if p.name != "last.json")
            slot = dest / str(n)
            slot.mkdir(parents=True, exist_ok=True)
            path = slot / "estimator.joblib"
            joblib.dump(est, path)
            payload["estimator_path"] = str(path.relative_to(root))
            payload["weights_dir"] = str(slot.relative_to(root))
    from protocol import autolog

    autolog.after_estimator(est, payload)
    return payload


def fit_estimator(src: Path, rec: dict, kind: str) -> dict:
    require_sklearn()
    from sklearn import ensemble, gaussian_process, linear_model, tree

    data = rec.get("data") or {}
    target = str(data.get("target") or "")
    if not target:
        raise SystemExit("data.target is required")
    feats, X, y_raw = load_xy(src, target)
    seed = int(opt(rec, "seed", 0))

    if kind == "linear":
        est = linear_model.LinearRegression()
        y = _y_float(y_raw)
        est.fit(X, y)
        return _persist(est, _reg_out(kind, feats, est, y, X), rec)
    if kind == "logistic":
        est = linear_model.LogisticRegression(max_iter=4000, random_state=seed)
        est.fit(X, y_raw)
        return _persist(
            est,
            {
                "kind": kind,
                "backend": "sklearn",
                "task": "classification",
                "features": feats,
                "classes": [str(c) for c in est.classes_],
                "weights": est.coef_[0].tolist()
                if len(est.coef_.shape) > 1
                else est.coef_.tolist(),
                "bias": float(est.intercept_[0])
                if hasattr(est.intercept_, "__len__")
                else float(est.intercept_),
                "sklearn": "LogisticRegression",
            },
            rec,
        )
    if kind == "ridge":
        lam = float(opt(rec, "lambda", 1.0, "penalty"))
        est = linear_model.Ridge(alpha=lam, random_state=seed)
        y = _y_float(y_raw)
        est.fit(X, y)
        out = _reg_out(kind, feats, est, y, X)
        out["lambda"] = lam
        return _persist(est, out, rec)
    if kind == "lasso":
        lam = float(opt(rec, "lambda", 0.5, "penalty"))
        est = linear_model.Lasso(alpha=lam, random_state=seed, max_iter=10000)
        y = _y_float(y_raw)
        est.fit(X, y)
        out = _reg_out(kind, feats, est, y, X)
        out["lambda"] = lam
        return _persist(est, out, rec)
    if kind == "elasticnet":
        lam = float(opt(rec, "lambda", 0.4, "penalty"))
        l1 = float(opt(rec, "l1_ratio", 0.5, "penalty"))
        est = linear_model.ElasticNet(
            alpha=lam, l1_ratio=l1, random_state=seed, max_iter=10000
        )
        y = _y_float(y_raw)
        est.fit(X, y)
        out = _reg_out(kind, feats, est, y, X)
        out["lambda"] = lam
        out["l1_ratio"] = l1
        return _persist(est, out, rec)
    if kind == "tree":
        depth = int(opt(rec, "depth", 3, "tree"))
        est = tree.DecisionTreeRegressor(max_depth=depth, random_state=seed)
        y = _y_float(y_raw)
        est.fit(X, y)
        return _persist(
            est,
            {
                "kind": kind,
                "backend": "sklearn",
                "task": "regression",
                "features": feats,
                "depth": depth,
                "train_loss": _mse(y, est.predict(X)),
                "sklearn": "DecisionTreeRegressor",
                "feature_importances": est.feature_importances_.tolist(),
                "tree_rules": tree.export_text(est, feature_names=feats),
            },
            rec,
        )
    if kind == "forest":
        n = int(opt(rec, "trees", 20, "forest"))
        depth = int(opt(rec, "depth", 3, "forest"))
        mtry = opt(rec, "mtry", None, "forest")
        est = ensemble.RandomForestRegressor(
            n_estimators=n,
            max_depth=depth,
            max_features=int(mtry) if mtry is not None else "sqrt",
            random_state=seed,
        )
        y = _y_float(y_raw)
        est.fit(X, y)
        return _persist(
            est,
            {
                "kind": kind,
                "backend": "sklearn",
                "task": "regression",
                "features": feats,
                "trees": n,
                "depth": depth,
                "train_loss": _mse(y, est.predict(X)),
                "feature_importances": est.feature_importances_.tolist(),
                "sklearn": "RandomForestRegressor",
            },
            rec,
        )
    if kind == "boosting":
        n = int(opt(rec, "trees", 100, "boosting"))
        depth = int(opt(rec, "depth", 3, "boosting"))
        lr = float(opt(rec, "lr", 0.1, "boosting"))
        y = _y_float(y_raw)
        lib = str(opt(rec, "library", "auto", "boosting")).lower()
        if lib in ("auto", "catboost"):
            try:
                from catboost import CatBoostRegressor

                est = CatBoostRegressor(
                    iterations=n,
                    depth=depth,
                    learning_rate=lr,
                    random_seed=seed,
                    verbose=False,
                )
                est.fit(X, y)
                return _persist(
                    est,
                    {
                        "kind": kind,
                        "backend": "catboost",
                        "task": "regression",
                        "features": feats,
                        "trees": n,
                        "depth": depth,
                        "lr": lr,
                        "train_loss": _mse(y, est.predict(X)),
                        "sklearn": "CatBoostRegressor",
                    },
                    rec,
                )
            except Exception:
                if lib == "catboost":
                    raise SystemExit(
                        "catboost not installed. From the framework tree run:\n"
                        "  python3 -m pip install catboost\n"
                        "Or reinstall: curl -fsSL https://aq.aquin.app/framework/install.sh | bash"
                    ) from None
        if lib in ("auto", "xgboost"):
            try:
                import xgboost as xgb

                # import can succeed while native lib fails (e.g. missing libomp on macOS)
                _ = xgb.__version__
                est = xgb.XGBRegressor(
                    n_estimators=n,
                    max_depth=depth,
                    learning_rate=lr,
                    random_state=seed,
                    verbosity=0,
                )
                est.fit(X, y)
                return _persist(
                    est,
                    {
                        "kind": kind,
                        "backend": "xgboost",
                        "task": "regression",
                        "features": feats,
                        "trees": n,
                        "depth": depth,
                        "lr": lr,
                        "train_loss": _mse(y, est.predict(X)),
                        "sklearn": "XGBRegressor",
                    },
                    rec,
                )
            except Exception:
                if lib == "xgboost":
                    raise SystemExit(
                        "xgboost failed (often missing OpenMP: brew install libomp). "
                        "Or set library: sklearn"
                    ) from None
        if lib in ("auto", "lightgbm"):
            try:
                import lightgbm as lgb

                est = lgb.LGBMRegressor(
                    n_estimators=n,
                    max_depth=depth,
                    learning_rate=lr,
                    random_state=seed,
                    verbosity=-1,
                )
                est.fit(X, y)
                return _persist(
                    est,
                    {
                        "kind": kind,
                        "backend": "lightgbm",
                        "task": "regression",
                        "features": feats,
                        "trees": n,
                        "depth": depth,
                        "lr": lr,
                        "train_loss": _mse(y, est.predict(X)),
                        "sklearn": "LGBMRegressor",
                    },
                    rec,
                )
            except Exception:
                if lib == "lightgbm":
                    raise SystemExit(
                        "lightgbm not installed. From the framework tree run:\n"
                        "  python3 -m pip install lightgbm\n"
                        "Or reinstall: curl -fsSL https://aq.aquin.app/framework/install.sh | bash"
                    ) from None
        est = ensemble.GradientBoostingRegressor(
            n_estimators=n, max_depth=depth, learning_rate=lr, random_state=seed
        )
        est.fit(X, y)
        return _persist(
            est,
            {
                "kind": kind,
                "backend": "sklearn",
                "task": "regression",
                "features": feats,
                "trees": n,
                "depth": depth,
                "lr": lr,
                "train_loss": _mse(y, est.predict(X)),
                "feature_importances": est.feature_importances_.tolist(),
                "sklearn": "GradientBoostingRegressor",
            },
            rec,
        )
    if kind == "gp":
        ls = opt(rec, "lengthscale", None, "gp")
        noise = float(opt(rec, "noise", 1e-5, "gp"))
        kernel = gaussian_process.kernels.RBF(length_scale=float(ls) if ls else 1.0)
        est = gaussian_process.GaussianProcessRegressor(
            kernel=kernel, alpha=noise, random_state=seed, normalize_y=True
        )
        y = _y_float(y_raw)
        est.fit(X, y)
        return _persist(
            est,
            {
                "kind": kind,
                "backend": "sklearn",
                "task": "regression",
                "features": feats,
                "lengthscale": float(est.kernel_.length_scale)
                if hasattr(est.kernel_, "length_scale")
                else None,
                "noise": noise,
                "train_loss": _mse(y, est.predict(X)),
                "sklearn": "GaussianProcessRegressor",
            },
            rec,
        )
    raise SystemExit(f"unknown tabular kind: {kind}")


def predict(model: dict, X: list[list[float]]) -> list:
    kind = model.get("kind")
    if kind in ("linear", "ridge", "lasso", "elasticnet") and "weights" in model:
        w = model["weights"]
        b = float(model.get("bias") or 0)
        return [sum(w[j] * row[j] for j in range(len(w))) + b for row in X]
    if kind == "logistic" and "weights" in model:
        import math

        w = model["weights"]
        b = float(model.get("bias") or 0)
        classes = model.get("classes") or ["0", "1"]
        out = []
        for row in X:
            z = sum(w[j] * row[j] for j in range(len(w))) + b
            p = 1.0 / (1.0 + math.exp(-z))
            out.append(classes[1] if p >= 0.5 else classes[0])
        return out
    raise SystemExit(
        f"predict for {kind}: missing weights; use evaluate() with estimator_path"
    )


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    data = rec.get("data") or {}
    target = str(data.get("target") or "")
    feats, X, y_raw = load_xy(src, target)
    if model.get("features") and list(model["features"]) != list(feats):
        raise SystemExit("feature mismatch vs checkpoint")
    path = model.get("estimator_path")
    train = rec.get("_train")
    if path and train:
        import joblib

        est = joblib.load(Path(train) / path)
        pred = est.predict(X).tolist()
    else:
        pred = predict(model, X)
    metric = str((rec.get("eval") or {}).get("metric") or "mse")
    if metric == "accuracy":
        y = [str(v) for v in y_raw]
        p = [str(v) for v in pred]
        ok = sum(1 for i in range(len(y)) if y[i] == p[i])
        return ok / max(len(y), 1), len(y)
    y = _y_float(y_raw)
    p = [float(v) for v in pred]
    if metric == "mae":
        return sum(abs(y[i] - p[i]) for i in range(len(y))) / len(y), len(y)
    if metric == "rmse":
        return _mse(y, p) ** 0.5, len(y)
    if metric == "r2":
        mean = sum(y) / len(y)
        ss_tot = sum((yi - mean) ** 2 for yi in y) or 1.0
        ss_res = sum((y[i] - p[i]) ** 2 for i in range(len(y)))
        return 1.0 - ss_res / ss_tot, len(y)
    return _mse(y, p), len(y)


def generate(
    model: dict,
    prompt: str,
    rec: dict,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict:
    """Tabular serve: predict one row from prompt / serve.features."""
    del max_tokens, temperature
    from backends.serve_io import parse_feature_row, result_text, serve_block

    block = serve_block(rec)
    feats = model.get("features") or []
    n = len(feats) if feats else None
    raw = prompt.strip() if prompt and prompt.strip() else None
    if raw is None and block.get("features") is not None:
        feat_val = block["features"]
        if isinstance(feat_val, list):
            row = [float(x) for x in feat_val]
        else:
            row = parse_feature_row(str(feat_val), n)
    else:
        row = parse_feature_row(raw or "", n)
    if n is not None and len(row) != n:
        raise SystemExit(f"expected {n} features ({feats}), got {len(row)}")

    path = model.get("estimator_path")
    train = rec.get("_train")
    if path and train:
        import joblib

        est = joblib.load(Path(train) / path)
        pred = est.predict([row])[0]
        # optional proba
        score = None
        if hasattr(est, "predict_proba"):
            try:
                proba = est.predict_proba([row])[0]
                score = float(max(proba))
            except Exception:
                score = None
    else:
        pred = predict(model, [row])[0]
        score = None

    label = str(pred)
    out = result_text(text=label, label=label, prediction=pred, features=row)
    if score is not None:
        out["score"] = score
    return out
