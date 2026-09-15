"""SDK example — build the path map from code (define), then train.

  cd tests/sdk-from-dict
  ../../aq/kernel/.venv/bin/python example.py
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

aq = Aquin.define(
    family="tabular",
    method="linear",
    data={"path": "data.csv", "target": "y"},
    eval={"metric": "mse", "min_score": 0.01},
    config_path=HERE / "recipe.yaml",
    artifacts=HERE / "artifacts",
)

aq.train()
print(aq.eval())
print("path map", aq.config_path)
print(aq.status())
