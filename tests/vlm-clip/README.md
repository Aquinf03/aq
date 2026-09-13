# VLM CLIP — end to end

Run (`recipe.yaml` + `data/pairs.jsonl`). Contrastive image–text (`method: clip`). Eval recall@1.

```
cd aq && npm run build
cd ..
```

Do not tick TODO until CLI and SDK paths work.

---

## 1. Manual CLI

```
./aq/bin/aq train tests/vlm-clip
./aq/bin/aq eval tests/vlm-clip
cat tests/vlm-clip/artifacts/inspect.md
```

---

## 2. Agent

```
cd tests/vlm-clip && ../../aq/bin/aq
```

Train, eval, report real recall from artifacts.

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./sdk   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("tests/vlm-clip")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
