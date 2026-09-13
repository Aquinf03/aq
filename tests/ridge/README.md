# Ridge — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). `y ≈ 2x + 3`. `z` is a noisy copy of `x` (collinear). Ridge (L2, `lambda: 1`) shrinks weights and still fits. Gate is MSE on `evals/holdout.csv` (`min_score` 1, lower is better). Inspect should list `lambda`, intercept, `x`, and `z` — **no exact zeros**.

```
cd aq && npm run build
cd ..
```

`aq` is on your PATH or `./aq/bin/aq`.

Do not tick TODO until CLI, agent, and SDK paths work.

---

## 1. Manual CLI

```
cd tests/ridge
aq train
aq eval
cat artifacts/inspect.md
aq status
```

Expect:

- train writes checkpoint + `artifacts/inspect.md`
- eval: `mse`, small score, **pass**
- inspect: `lambda: 1`, both `x` and `z` nonzero

Optional: `aq fork` this run, set `method: linear`, train the copy, compare inspect. Linear may split collinear weights more wildly; ridge should stay finite.

---

## 2. Agent

```
cd tests/ridge
aq
```

- Train this ridge train, then eval the holdout. Report mse and pass/fail from aq eval. Do not invent a pass.
- Read inspect.md. What is lambda? Are both x and z nonzero?

```
aq ask tests/ridge -y "Train ridge, then aq eval. Report mse and pass/fail. Read inspect.md."
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/ridge")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI: eval pass, inspect has lambda and two finite weights
- Agent: same, no fake pass
- SDK: train + eval on this folder
