# Tokenizer in the train — hashed like weights

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). The tokenizer is **`artifacts/tokenizer.json`**. Its sha256 is on the checkpoint and in the run record. Eval encodes with **that file**, not a new fit. Change the file, eval must refuse.

Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd scripts/tests/tokenizer-in-train
aq train
aq eval
aq data hash
cat artifacts/inspect.md
```

Expect:

- train prints `artifacts/tokenizer.json` and `tokenizer sha256:...`
- that hash is in `artifacts/checkpoints/last.json` as `tokenizer_sha256`
- eval **pass** (loads the pinned file)
- `aq data hash` after train also prints the tokenizer sha256

Then:

```
printf '%s\n' '{"kind":"bpe","itos":["x"],"merges":[]}' > artifacts/tokenizer.json
aq eval
```

Expect: **fail**: tokenizer.json hash does not match checkpoint. Re-train to restore the file before you tick.

---

## 2. Agent

```
cd scripts/tests/tokenizer-in-train
aq
```

Train, then eval. Report pass/fail from aq eval. Read inspect.md. What is tokenizer_sha256? Then break tokenizer.json and eval again. Did it refuse?

```
aq ask scripts/tests/tokenizer-in-train -y "Train, then aq eval. Report pass/fail. Read inspect.md tokenizer_sha256. Then write junk to artifacts/tokenizer.json and aq eval. Did it fail on hash?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/tokenizer-in-train")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: train pins hash, eval passes, junk tokenizer.json makes eval refuse
- Agent: same, no fake pass
