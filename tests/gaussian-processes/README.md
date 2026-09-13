# Gaussian processes — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). `y` is **sin(x)** on one period. A GP (`kernel: rbf`) should interpolate the curve. A straight line would miss the peaks. Gate is MSE on `evals/holdout.csv` (`min_score` 0.05). Inspect is kernel, lengthscale, noise, and a posterior band (mean ± std), not weights or a flowchart.

Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

From this run:

```
cd tests/gaussian-processes
aq train
aq eval
cat artifacts/inspect.md
aq status
```

Expect:

- train writes checkpoint + `artifacts/inspect.md`
- eval: `mse` small, **pass**
- inspect: `kernel: rbf`, a **lengthscale**, `noise`, and train rows with mean ± std (std small on the train points)

If eval fails, do not mark the family done.

Optional:

```
aq doctor
aq data hash
```

---

## 2. Agent

```
cd tests/gaussian-processes
aq
```

Ask, in your own words:

- Train this GP, then eval the holdout. Report mse and pass/fail from aq eval. Do not invent a pass.
- Read inspect.md. What kernel and lengthscale? Are the train posterior stds small?

One-shot:

```
aq ask tests/gaussian-processes -y "Train the GP, then aq eval. Report mse and pass/fail. Read inspect.md. Kernel and lengthscale?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/gaussian-processes")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: eval **pass**, inspect is a GP (kernel + lengthscale + bands), not a line or a tree
- Agent: same numbers from `aq eval` / inspect, no fake pass
