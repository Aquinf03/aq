# Autoregressive pretrain (next-token)

This train is **causal LM**: each token is predicted from the left only. Loss is next-token CE on packed windows. Inspect must say `objective: next-token` and `causal: true`. Not BERT-style mask fill.

Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd tests/ar-pretrain
aq train
aq eval
cat artifacts/inspect.md
```

Expect:

- eval **pass**
- inspect: `objective: next-token`, `causal: true`, a `context`, `n_pred` (positions trained)

---

## 2. Agent

```
cd tests/ar-pretrain
aq
```

Train, then aq eval. Report pass/fail. Read inspect.md. Is it next-token and causal?

```
aq ask tests/ar-pretrain -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, causal, n_pred?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/ar-pretrain")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: eval pass, inspect is next-token + causal
- Agent: numbers from aq eval, no fake pass
