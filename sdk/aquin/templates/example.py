"""Aquin SDK example — edit recipe.yaml, then run: python example.py"""

from pathlib import Path

from aquin import Aquin

HERE = Path(__file__).resolve().parent

aq = Aquin(HERE)  # recipe.yaml beside this file; artifacts/ created on train
aq.train()
print(aq.eval())
print(aq.status())
