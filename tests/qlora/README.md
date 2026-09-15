# QLoRA

Needs **NVIDIA CUDA + bitsandbytes**. On MPS/CPU/ROCm, `bits: 4` / `method: qlora` fails closed — use LoRA without bits.

**base** is next-token. **tune** continues with QLoRA from that checkpoint (`init.checkpoint`).

```
cd tests/qlora/base && aq train   # on a CUDA machine
cd ../tune && aq train && aq eval
```

Expect checkpoint `objective: qlora`, `qlora_engine: bitsandbytes`, `bits: 4`.
---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

Train `base` before `tune`. CUDA + bitsandbytes for qlora tune.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/qlora/base")
print(aq.train())
print(aq.eval())
aq = Aquin("tests/qlora/tune")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
