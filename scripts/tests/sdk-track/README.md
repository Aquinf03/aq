# sdk-track — few-line tracking SDK

Drop-in tracking for **your** train loop (not `aq train`). Same folder store.

```text
scripts/tests/sdk-track/
  recipe.yaml      # path map (folder identity)
  data.csv
  example.py       # autolog → fit → log_* → finish
  artifacts/       # created when you run
```

## Run it

```bash
aq/kernel/.venv/bin/pip install -e ./aq
cd scripts/tests/sdk-track
../../../aq/kernel/.venv/bin/python example.py
```

```python
from aquin import autolog, log_params, log_metric, set_tags, finish

autolog("sklearn", train=".")
log_params({"alpha": 1.0})
# … fit …
log_metric("mse", 0.02)
set_tags("baseline")
finish()
```

## Pass bar

- `python example.py` writes `artifacts/metrics.jsonl` and `artifacts/runs/<id>.json`
- run record has tags / notes / params
- sklearn fit appears as a step (autolog)
