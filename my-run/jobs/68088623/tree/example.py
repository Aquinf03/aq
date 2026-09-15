"""Train / eval this run. Job plans live in recipe.yaml — use aq job plan.

  python example.py
  # or: aq train && aq eval
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

aq = Aquin(HERE)
aq.train()
print(aq.eval())
print("plans in path map:", aq.plans())
print(aq.status())
