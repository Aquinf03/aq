# Decision trees — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). `y` is **1** for `x ≤ 4` and **9** for `x ≥ 5`. A tree should split on `x` around 4.5. Gate is MSE on `evals/holdout.csv` (`min_score` 0.01). Inspect is the flowchart, not a weight vector.

```
cd aq && npm run build
cd ..
```

Do not tick TODO until CLI, agent, and SDK paths work.

---

## 1. Manual CLI

```
cd tests/decision-trees
aq train
aq eval
cat artifacts/inspect.md
aq status
```

Expect:

- train writes checkpoint + `artifacts/inspect.md`
- eval: `mse` near 0, **pass**
- inspect: `if x <= …` then leaf ~1, else leaf ~9

A linear model would smear the jump. The tree should not.

---

## 2. Agent

```
cd tests/decision-trees
aq
```

- Train this tree, then eval the holdout. Report mse and pass/fail from aq eval. Do not invent a pass.
- Read inspect.md. Where does it split on x? What are the two leaves?

```
aq ask tests/decision-trees -y "Train the tree, then aq eval. Report mse and pass/fail. Read inspect.md."
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/decision-trees")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: eval pass, inspect is a split on x
- Agent: same, no fake pass
