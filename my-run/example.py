"""Train / eval this run — edit recipe.yaml or use Aquin.define.

  python example.py
  # or: aq train && aq eval
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

aq = Aquin(HERE)
aq.train()
print(aq.eval())
print(aq.status())
