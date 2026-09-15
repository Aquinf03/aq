# Multi-token prediction

`objective: mtp` trains auxiliary heads on a causal LM: at each position, predict **t+1**, **t+2**, … (**`n_predict:`**, default 2).

```
cd aq && npm run build
cd tests/mtp-pretrain
aq train
aq eval
cat artifacts/inspect.md
```

Expect: eval **pass**. Inspect `objective: mtp`, `n_predict: 2`.

Requires **`n_predict >= 2`**. LoRA/QLoRA not supported yet.
---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/mtp-pretrain")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
