"""Smoke: aquin.table(...) → artifacts/tables → aq plot table.

    PYTHONPATH=aq:aq/kernel ../.venv/bin/python example.py
    ../../../aq/bin/aq plot table preds
"""

from pathlib import Path

from aquin import finish, table

HERE = Path(__file__).resolve().parent

# seed a few prediction rows (named table "preds")
for i, (y, yhat, text) in enumerate(
    [
        (1, 0, "false negative — missed class"),
        (1, 1, "ok"),
        (0, 1, "false positive"),
        (0, 0, "ok"),
        (1, 0, "another miss"),
        (1, 1, "ok again"),
        (0, 0, "ok"),
        (1, 1, "ok"),
        (0, 1, "fp on rare token"),
        (1, 0, "fn on edge case"),
    ]
):
    err = abs(y - yhat)
    table(
        "preds",
        id=i,
        y=y,
        yhat=yhat,
        err=err,
        text=text,
        train=HERE,
        step=i,
    )

# also a default table row
table(note="smoke", n=10, train=HERE)

finish()
print("wrote", HERE / "artifacts" / "tables")
print("browse:  aq plot table preds")
print("         aq plot table          # default / first table")
print("keys:    ↑↓ scroll  / or Ctrl+F find  s sort  c clear  q quit")
