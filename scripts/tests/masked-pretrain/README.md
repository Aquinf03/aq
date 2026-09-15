# Masked LM / span corruption

Two trains. **Not** next-token.

- `mlm/` — BERT-style: hide tokens, encoder fills them (`objective: mlm`, `causal: false`)
- `span/` — T5-style: drop a span, encoder-decoder emits it (`objective: span`)

Do not tick TODO until CLI + SDK on each path (agent on at least one).

```
cd aq && npm run build
cd ..
```

---

## 1. MLM

```
cd scripts/tests/masked-pretrain/mlm
aq train
aq eval
cat artifacts/inspect.md
```

Expect: eval **pass**. Inspect `objective: mlm`, `causal: false`, `mask_rate`.

## 2. Span

```
cd scripts/tests/masked-pretrain/span
aq train
aq eval
cat artifacts/inspect.md
```

Expect: eval **pass**. Inspect `objective: span`.

---

## Agent

```
cd scripts/tests/masked-pretrain/mlm
aq
```

Train, then aq eval. Report pass/fail. Read inspect.md. Is it mlm, not next-token?

```
aq ask scripts/tests/masked-pretrain/mlm -y "Train, then aq eval. Report pass/fail. Read inspect.md. objective, causal, mask_rate?"
```
---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/masked-pretrain/mlm")
print(aq.train())
print(aq.eval())
aq = Aquin("scripts/tests/masked-pretrain/span")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
