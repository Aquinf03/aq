# sdk-from-dict

`Aquin.define(...)` (alias: `from_dict`) authors the run in Python and **writes `recipe.yaml` as the path map**, then trains into `artifacts/`.

```
sdk-from-dict/
  example.py       # define → recipe.yaml → train/eval
  data.csv
  evals/
  recipe.yaml      # rewritten by example.py
  artifacts/       # runtime
```

```bash
cd scripts/tests/sdk-from-dict
../../../aq/kernel/.venv/bin/python example.py
```

## Expect

- path map rewritten from `define(...)`
- train + eval **pass**
