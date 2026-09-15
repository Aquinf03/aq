# Gradient boosting — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). `y` is **two jumps added**: small `x` → 1 else 9, plus small `z` → 1 else 9 (so 2 / 10 / 18). One stump can only cut one feature. Boosting (`trees: 30`, `depth: 1`) should fit **both**. Gate is MSE on `evals/holdout.csv` (`min_score` 1). Inspect is round count and split counts, not one flowchart.

XGBoost / LightGBM / CatBoost are libraries for this family. This fixture is the family itself (`method: boosting`). Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

From this run:

```
cd tests/gradient-boosting
aq train
aq eval
cat artifacts/inspect.md
aq status
```

Expect:

- train writes checkpoint + `artifacts/inspect.md`
- eval: `mse` small, **pass**
- inspect: `trees: 30`, `depth: 1`, **both** `x` and `z` in splits used
- first rounds in inspect are single splits (stumps), not a deep tree

If eval fails, do not mark the family done. If inspect only uses `x` or only `z`, the booster did not learn the additive part.

Optional:

```
aq doctor
aq data hash
```

---

## 2. Agent

```
cd tests/gradient-boosting
aq
```

Ask, in your own words:

- Train this booster, then eval the holdout. Report mse and pass/fail from aq eval. Do not invent a pass.
- Read inspect.md. How many trees? Did both x and z get used?

One-shot:

```
aq ask tests/gradient-boosting -y "Train the booster, then aq eval. Report mse and pass/fail. Read inspect.md. Did both x and z get used?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/gradient-boosting")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: eval **pass**, inspect shows a sequence of stumps and splits on **both** x and z
- Agent: same numbers from `aq eval` / inspect, no fake pass
