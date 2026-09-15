# Continued pretrain

Two trains. **base** is next-token from scratch. **continue** loads that checkpoint, keeps the tokenizer, and next-token trains on extra lines. Inspect on continue: `objective: continued-pretrain`, `parent`, `parent_sha256`.

Train **base first**. Then continue.

Do not tick TODO until CLI + SDK on base/continue (agent on continue after base).

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd scripts/tests/continued-pretrain/base
aq train
aq eval

cd ../continue
aq train
aq eval
cat artifacts/inspect.md
```

Expect: both eval **pass**. Continue inspect: `objective: continued-pretrain`, a `parent` path, `parent_sha256`.

---

## 2. Agent

From continue, after base is trained:

```
cd scripts/tests/continued-pretrain/continue
aq
```

Train this continued pretrain (parent is ../base). Then aq eval. Report pass/fail. Read inspect.md. objective, parent, parent_sha256?

```
aq ask scripts/tests/continued-pretrain/continue -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, parent, parent_sha256?"
```

If base has no checkpoint, train `scripts/tests/continued-pretrain/base` first.

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

Train `base` before `continue`.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/continued-pretrain/base")
print(aq.train())
print(aq.eval())
aq = Aquin("scripts/tests/continued-pretrain/continue")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
