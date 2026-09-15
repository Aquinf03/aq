# Serve a checkpoint

After **aq train**, **aq serve** loads the checkpoint and generates text. Kernel-owned forward pass. Tokenizer hash must match. Output: `artifacts/serve.json` plus the text on stdout.

Do not tick TODO until CLI, agent, and SDK paths work.

```
cd aq && npm run build
cd ..
```

---

## 1. Manual CLI

```
cd scripts/tests/serve-checkpoint
aq train
aq eval
aq serve "the cat"
cat artifacts/serve.json
aq status
```

Expect:

- eval **pass**
- serve prints generated **text** (prompt + completion)
- `artifacts/serve.json` has `prompt`, `text`, `completion`, `tokens`, `checkpoint`
- `aq status` shows the last serve line

Also works with recipe default:

```
aq serve
```

(`serve.prompt: the cat` in recipe.yaml)

---

## 2. Agent

```
cd scripts/tests/serve-checkpoint
aq
```

Train if needed, then aq serve with a prompt. Read artifacts/serve.json. Report text and token count. Do not invent output.

```
aq ask scripts/tests/serve-checkpoint -y "Train if needed, then aq serve the cat. Read artifacts/serve.json. text, tokens, checkpoint?"
```

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

After train, also `aq.serve("hello")` / `aq serve`.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/serve-checkpoint")
print(aq.train())
print(aq.eval())
print(aq.serve("hello", max_tokens=16))
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- SDK: same train/eval (or documented skip) via `aquin`

- CLI: train, eval pass, serve writes serve.json with non-empty text
- Agent: output from aq serve / serve.json, no fake generation
