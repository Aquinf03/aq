"""SDK example — build the YAML from code, then train (still durable on disk).

  cd tests/sdk-from-dict
  ../../aq/kernel/.venv/bin/python example.py
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

# data/evals already in this folder
aq = Aquin.from_dict(
    {
        "family": "tabular",
        "method": "linear",
        "data": {"path": "data.csv", "target": "y"},
        "eval": {"metric": "mse", "min_score": 0.01},
    },
    config_path=HERE / "recipe.yaml",
    artifacts=HERE / "artifacts",
)
aq.train()
print(aq.eval())
print("wrote", aq.config_path)
print(aq.status())
