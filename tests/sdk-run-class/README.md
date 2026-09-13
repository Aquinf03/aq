# sdk-run-class

Class-as-run + `@schedule` / `@pipeline`. On `LinearRun.create(".")` the SDK writes **`recipe.yaml` (path map)** then you call `.train()`.

```bash
cd tests/sdk-run-class
../../aq/kernel/.venv/bin/python example.py
# plans visible to CLI:
aq job plan .
```

## Expect

- `recipe.yaml` contains `plans.nightly` + `plans.pipe`
- train + eval **pass**
