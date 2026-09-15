# SFT (supervised fine-tune)

**base** is next-token from scratch. **tune** loads that checkpoint and trains on prompt → completion. Loss is **only on the completion**. Inspect: `objective: sft`, `loss_on: completion`, `parent`.

Train **base first**.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd tests/sft/base
aq train
aq eval

cd ../tune
aq train
aq eval
cat artifacts/inspect.md
```

Expect: both eval **pass**. Tune inspect: `objective: sft`, `loss_on: completion`, `parent`.

---

## 2. Agent

After base is trained:

```
cd tests/sft/tune
aq
```

Train this SFT, then aq eval. Report pass/fail. Read inspect.md. objective, loss_on, parent?

```
aq ask tests/sft/tune -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, loss_on, parent?"
```

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

Train `base` before `tune`.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/sft/base")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/sft/tune")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
