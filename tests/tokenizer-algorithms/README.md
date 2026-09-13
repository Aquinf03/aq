# Tokenizer algorithms

Four trains. Same tiny decoder, four **kinds**: `byte`, `bpe`, `wordpiece`, `unigram`. Inspect `tokenizer:` must match the recipe. File still hashed in the train (`artifacts/tokenizer.json`).

Do not tick TODO until CLI + SDK on all four (agent on at least one).

```
cd aq && npm run build
cd ..
```

---

## 1. Byte-level

UTF-8 bytes. Recipe `tokenizer: byte`.

```
cd tests/tokenizer-algorithms/byte
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `tokenizer: byte`, eval **pass**.

## 2. BPE

```
cd tests/tokenizer-algorithms/bpe
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `tokenizer: bpe`.

## 3. WordPiece

```
cd tests/tokenizer-algorithms/wordpiece
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `tokenizer: wordpiece`.

## 4. Unigram

```
cd tests/tokenizer-algorithms/unigram
aq train
aq eval
cat artifacts/inspect.md
```

Expect: `tokenizer: unigram`.

---

## Agent

```
cd tests/tokenizer-algorithms/bpe
aq
```

Train, then aq eval. Report pass/fail. Read inspect.md. What tokenizer kind?

```
aq ask tests/tokenizer-algorithms/bpe -y "Train, then aq eval. Report pass/fail. Read inspect.md. tokenizer kind?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/tokenizer-algorithms/byte")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/tokenizer-algorithms/bpe")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/tokenizer-algorithms/wordpiece")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/tokenizer-algorithms/unigram")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- All four: eval **pass**, inspect kind matches the recipe
- Agent: numbers from `aq eval`, no fake pass
