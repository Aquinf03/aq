# aquin — Python SDK

**Shape:** SDK + `recipe.yaml` + `artifacts/`. Paths (data, evals, …) live in the YAML — no slot forest.

```bash
pip install -e ./sdk
# kernel deps into the same Python:
pip install -r aq/kernel/requirements.txt
```

## Init a run

```bash
python -m aquin init my-run
cd my-run
# edit recipe.yaml → data.path
python example.py
```

Same scaffold via CLI: `aq init my-run`.

## Use

```python
from aquin import Aquin

aq = Aquin(".")  # directory with recipe.yaml
aq.train()
aq.eval()
```

Examples: [`tests/sdk-ridge`](../tests/sdk-ridge/), [`tests/sdk-from-dict`](../tests/sdk-from-dict/).

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.
