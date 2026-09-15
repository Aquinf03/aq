# aquin — Python SDK

**Shape:** **`recipe.yaml` (path map) + `artifacts/` (runtime).**  
Author with **YAML** and/or the **SDK** — both are first-class; pick either (or mix).

```bash
pip install -e ./aq
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
```

```python
from aquin import Aquin

aq = Aquin(".")  # reads recipe.yaml
aq.train()
aq.eval()
```

```bash
aq train && aq eval
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
aq.train()
aq.eval()
```

Optional class style: `Run` → same `recipe.yaml`.

Examples: [`scripts/tests/sdk-ridge`](../scripts/tests/sdk-ridge/) (YAML-first), [`scripts/tests/sdk-from-dict`](../scripts/tests/sdk-from-dict/) / [`scripts/tests/sdk-run-class`](../scripts/tests/sdk-run-class/) (SDK-first).

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.
