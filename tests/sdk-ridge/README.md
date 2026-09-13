# sdk-ridge — SDK example

Same idea as a YAML fixture: this folder is a run. **`example.py` is the SDK you write**; `recipe.yaml` is the config.

```text
tests/sdk-ridge/
  recipe.yaml      # config
  data.csv
  evals/
  example.py       # SDK
  artifacts/       # created when you run
```

No `experiment.md`. No slot forest.

## Run it

```bash
aq/kernel/.venv/bin/pip install -e ./sdk
cd tests/sdk-ridge
../../aq/kernel/.venv/bin/python example.py
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
./aq/bin/aq train tests/sdk-ridge
./aq/bin/aq eval tests/sdk-ridge
```

## Pass bar

- `python example.py` trains + evals (holdout **pass**)
- CLI on the same folder matches
