# sdk-run-class

Class-as-run. On `LinearRun.create(".")` the SDK writes **`recipe.yaml` (path map)** then you call `.train()`.

```bash
cd scripts/tests/sdk-run-class
../../../aq/kernel/.venv/bin/python example.py
```

## Expect

- `recipe.yaml` rewritten from the class attrs
- train + eval **pass**
