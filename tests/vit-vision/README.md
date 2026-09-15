# ViT vision — end to end

Run (`recipe.yaml` + `data/images`). aq-owned ViT (`vit-t/16`) on circle vs square.

```
cd aq && npm run build
cd ..
```

Do not tick TODO until CLI and SDK paths work.

---

## 1. Manual CLI

```
./aq/bin/aq train tests/vit-vision
./aq/bin/aq eval tests/vit-vision
cat tests/vit-vision/artifacts/inspect.md
```

---

## 2. Agent

```
cd tests/vit-vision && ../../aq/bin/aq
```

Train, eval, report real metrics from artifacts.

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/vit-vision")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
