"""SDK example — class-as-run + @schedule (YAML path map written on create).

  cd tests/sdk-run-class
  ../../aq/kernel/.venv/bin/python example.py
"""

from pathlib import Path

from aquin import Run, pipeline, schedule

HERE = Path(__file__).resolve().parent


@schedule(every=60, run="train")
@pipeline("pipe", "train", "eval")
class LinearRun(Run):
    family = "tabular"
    method = "linear"
    data = {"path": "data.csv", "target": "y"}
    eval = {"metric": "mse", "min_score": 0.01}


aq = LinearRun.create(HERE)
aq.train()
print(aq.eval())
print("path map", aq.config_path)
print("plans", aq.plans())
print(aq.status())
