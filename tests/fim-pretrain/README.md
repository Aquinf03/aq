# Fill-in-the-middle

Causal decoder. Each doc is rearranged **prefix / suffix / middle** so infill is next-token. Inspect: `objective: fim`, `causal: true`, `fim_order: psm`.

Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd tests/fim-pretrain
aq train
aq eval
cat artifacts/inspect.md
```

Expect: eval **pass**. Inspect `objective: fim`, `causal: true`, `fim_order: psm`.

---

## 2. Agent

```
cd tests/fim-pretrain
aq
```

Train, then aq eval. Report pass/fail. Read inspect.md. objective, fim_order, causal?

```
aq ask tests/fim-pretrain -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, fim_order, causal?"
```

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/fim-pretrain")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
