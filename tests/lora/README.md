# LoRA

**base** is next-token from scratch. **tune** loads that checkpoint, **freezes** it, and trains rank-4 LoRA on the LM head. Loss on completion only. Inspect: `objective: lora`, `rank`, `frozen: true`, `parent`.

Train **base first**.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd tests/lora/base
aq train
aq eval

cd ../tune
aq train
aq eval
cat artifacts/inspect.md
```

Expect: both eval **pass**. Tune inspect: `objective: lora`, `rank: 4`, `frozen: true`, `parent`.

---

## 2. Agent

After base is trained:

```
cd tests/lora/tune
aq
```

Train this LoRA, then aq eval. Report pass/fail. Read inspect.md. objective, rank, frozen, parent?

```
aq ask tests/lora/tune -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, rank, frozen, parent?"
```

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

Train `base` before `tune`.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/lora/base")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/lora/tune")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
