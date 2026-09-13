"""SDK example — same shape as recipe.yaml: this is the code you write.

From repo root (kernel venv):

  aq/kernel/.venv/bin/pip install -e ./sdk
  cd tests/sdk-ridge
  ../../aq/kernel/.venv/bin/python example.py
"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

aq = Aquin(HERE)  # recipe.yaml + artifacts/ beside this file
aq.train()
print(aq.eval())
print(aq.status())
