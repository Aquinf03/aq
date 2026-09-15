# sdk-ridge — SDK example

Open an existing **path map** (`recipe.yaml`) with the client. Runtime → `artifacts/`.

```text
scripts/tests/sdk-ridge/
  recipe.yaml      # path map
  data.csv
  evals/
  example.py       # Aquin(".")
  artifacts/       # created when you run
```

For SDK that *writes* the path map, see [`sdk-from-dict`](../sdk-from-dict/) or [`sdk-run-class`](../sdk-run-class/).

## Run it

```bash
aq/kernel/.venv/bin/pip install -e ./aq
cd scripts/tests/sdk-ridge
../../../aq/kernel/.venv/bin/python example.py
```

```python
from aquin import Aquin
from pathlib import Path

aq = Aquin(Path(__file__).resolve().parent)
aq.train()
print(aq.eval())
```

## CLI parity

```bash
./aq/bin/aq train scripts/tests/sdk-ridge
./aq/bin/aq eval scripts/tests/sdk-ridge
```

## Pass bar

- `python example.py` trains + evals (holdout **pass**)
- CLI on the same folder matches
