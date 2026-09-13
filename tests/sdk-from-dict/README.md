# sdk-from-dict — SDK example

Shows `Aquin.from_dict(...)`: you build the recipe in Python; it still **writes `recipe.yaml`**, then trains into `artifacts/`.

```text
tests/sdk-from-dict/
  data.csv
  evals/
  example.py       # writes recipe.yaml, then train/eval
  recipe.yaml      # created/updated by example.py
  artifacts/       # created on train
```

## Run it

```bash
aq/kernel/.venv/bin/pip install -e ./sdk
cd tests/sdk-from-dict
../../aq/kernel/.venv/bin/python example.py
```

## Pass bar

- `example.py` writes `recipe.yaml`, trains, eval **pass**
- Re-open with `Aquin("tests/sdk-from-dict")` works after the first run
