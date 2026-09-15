# CNN vision — end to end

Run (`recipe.yaml` + `data/images`). aq-owned ResNet classifies circle vs square. Gate/inspect per recipe (`family: vision`, `method: cnn`).

```
cd aq && npm run build
cd ..
```

Do not tick TODO until CLI and SDK paths work (GPU optional; CPU ok if slow).

---

## 1. Manual CLI

```
./aq/bin/aq train scripts/tests/cnn-vision
./aq/bin/aq eval scripts/tests/cnn-vision
cat scripts/tests/cnn-vision/artifacts/inspect.md
```

---

## 2. Agent

```
cd scripts/tests/cnn-vision && ../../../aq/bin/aq
```

Ask to train, eval, and report real metrics from artifacts — do not invent a pass.

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/cnn-vision")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
