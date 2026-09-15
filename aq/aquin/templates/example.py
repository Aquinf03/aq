"""Either path works — edit recipe.yaml, or author with Aquin.define / Run.

  python example.py
  # or: aq train && aq eval
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

# --- option A: YAML path map (edit recipe.yaml, then open it) ---
aq = Aquin(HERE)

# --- option B: SDK authors the path map (uncomment to use instead) ---
# aq = Aquin.define(
#     family="tabular",
#     method="linear",
#     data={"path": "data.csv", "target": "y"},
#     eval={"metric": "mse", "min_score": None},
#     config_path=HERE / "recipe.yaml",
#     artifacts=HERE / "artifacts",
# )

aq.train()
print(aq.eval())
print(aq.status())
