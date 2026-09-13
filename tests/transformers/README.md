# Transformers — end to end

Three trains. Same method (`transformer`), three **types**: decoder, encoder, encoder-decoder. Kernel-owned `fit`. No PyTorch. No Hugging Face. Training here is next-token / classify / copy with cross-entropy, not SFT or LoRA. Those are later recipe slots.

Do not tick TODO until CLI + SDK on all three (agent on at least one).

```
cd aq && npm run build
cd ..
```

---

## 1. Decoder

Repeating `ab` / `cd`. Next-token. Gate: `eval.metric: loss`, `min_score` 0.8.

```
cd tests/transformers/decoder
aq train
aq eval
cat artifacts/inspect.md
```

Expect: inspect `arch: decoder`. Eval **pass**. Loss below 0.8.

## 2. Encoder

`y` is the repeated letter. Classify. Gate: accuracy `min_score` 1.

```
cd tests/transformers/encoder
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `arch: encoder`. Eval **pass**.

## 3. Encoder-decoder

`tgt` copies `src`. Gate: accuracy `min_score` 0.8.

```
cd tests/transformers/encoder-decoder
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `arch: encoder-decoder`. Eval **pass**.

---

## Agent

```
cd tests/transformers/decoder
aq
```

Train this decoder, then aq eval. Report loss and pass/fail from aq eval. Read inspect.md. What arch?

```
aq ask tests/transformers/decoder -y "Train the transformer, then aq eval. Report loss and pass/fail. Read inspect.md. What arch?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/transformers/decoder")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/transformers/encoder")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/transformers/encoder-decoder")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- All three: eval **pass**, inspect shows the right `arch`
- Agent: numbers from `aq eval`, no fake pass
