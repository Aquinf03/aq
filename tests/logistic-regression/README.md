# Logistic regression — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). `y` is `0` for small `x`, `1` for large `x`. Fit on `data.csv`. Gate is **accuracy** on `evals/holdout.csv` (`min_score` 1, higher is better). After train, `artifacts/inspect.md` should show a **positive** weight on `x` (larger `x` → class 1).

Build the CLI first if needed:

```
cd aq && npm run build
cd ..
```

`aq` is `aq/bin/aq` on your PATH, or `./aq/bin/aq` from the repo root.

Do not tick TODO until CLI, agent, and SDK paths work.

---

## 1. Manual CLI

From the repo root:

```
aq doctor tests/logistic-regression
aq data hash tests/logistic-regression
aq train tests/logistic-regression
aq eval tests/logistic-regression
aq status tests/logistic-regression
```

Or:

```
cd tests/logistic-regression
aq train
aq eval
cat artifacts/inspect.md
aq status
```

Expect:

- train writes `artifacts/checkpoints/last.json` and `artifacts/inspect.md`
- eval prints `accuracy`, `1`, `pass`
- inspect: `x` weight > 0, classes `0` and `1`

To see a **fail**, flip a holdout `y` and run `aq eval` again.

---

## 2. Agent

```
cd tests/logistic-regression
aq
```

Need a provider. Then:

- Hash the data, then train this logistic train.
- Eval the holdout. Report accuracy and pass/fail from `aq eval`. Do not invent a pass.
- Read `artifacts/inspect.md`. Is the weight on `x` positive?

One-shot:

```
aq ask tests/logistic-regression -y "Train this logistic model, then aq eval. Report accuracy and pass/fail from the eval file. Read inspect.md."
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/logistic-regression")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: train + eval pass, `x` weight positive
- Agent: same, and it does not claim pass if eval failed
