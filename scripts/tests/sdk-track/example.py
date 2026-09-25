"""Few-line tracking SDK — your script, aquin hooks, folder store.

    python example.py

Writes artifacts/metrics.jsonl + artifacts/runs/<id>.json (same as aq train).
"""

from pathlib import Path

from aquin import autolog, finish, log_metric, log_param, log_params, set_notes, set_tags
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_squared_error
import numpy as np
import csv

HERE = Path(__file__).resolve().parent


def _xy(path: Path):
    with path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    X = [[float(r["x"]), float(r["z"])] for r in rows]
    y = [float(r["y"]) for r in rows]
    return np.asarray(X), np.asarray(y)


# 1) one call — hooks + metrics session on this train folder
autolog("sklearn", train=HERE)

# 2) optional crumbs (W&B / MLflow-shaped)
log_params({"alpha": 1.0, "solver": "auto"})
log_param("seed", 0)
set_tags("sdk-track", "few-line")
set_notes("standalone script — not aq train")

# 3) train as usual — sklearn fit is autologged
X, y = _xy(HERE / "data.csv")
model = Ridge(alpha=1.0, random_state=0).fit(X, y)
mse = float(mean_squared_error(y, model.predict(X)))
log_metric("mse", mse)

# 4) finish → runs/<id>.json
arts = finish()
print("mse", mse)
print("artifacts", arts or "metrics.jsonl + runs/")
print("run", HERE / "artifacts" / "runs" / "last.json")
