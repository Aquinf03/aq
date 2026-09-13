# aquin — Python SDK

**Shape:** **`recipe.yaml` (path map) + `artifacts/` (runtime).**  
Author with **YAML** and/or the **SDK** — both are first-class; pick either (or mix).

```bash
pip install -e ./sdk
pip install -r aq/kernel/requirements.txt
```

## Init a run

```bash
python -m aquin init my-run
cd my-run
# edit recipe.yaml → data.path   OR   switch example.py to Aquin.define
python example.py
# or: aq train && aq eval
```

Same scaffold via CLI: `aq init my-run`.

## Option A — edit YAML, open with SDK / CLI

```yaml
# recipe.yaml
family: tabular
method: linear
data:
  path: data.csv
  target: y
eval:
  metric: mse
plans:
  nightly:
    kind: cron
    every: 60
    run: train
```

```python
from aquin import Aquin

aq = Aquin(".")  # reads recipe.yaml
aq.train()
aq.eval()
```

```bash
aq train && aq eval
aq job plan run nightly
```

## Option B — author in Python (writes the same path map)

```python
from aquin import Aquin

aq = Aquin.define(
    family="tabular",
    method="linear",
    data={"path": "data.csv", "target": "y"},
    eval={"metric": "mse"},
    config_path="recipe.yaml",
)
aq.plan("nightly", kind="cron", every=60, run="train")
aq.train()
aq.eval()
```

Optional class style: `Run` + `@schedule` / `@pipeline` → same `recipe.yaml`.

You can also open a hand-edited YAML and add plans from code: `Aquin(".").plan("pipe", kind="pipeline", steps=["train", "eval"])`.

Examples: [`tests/sdk-ridge`](../tests/sdk-ridge/) (YAML-first), [`tests/sdk-from-dict`](../tests/sdk-from-dict/) / [`tests/sdk-run-class`](../tests/sdk-run-class/) (SDK-first).

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.
