# aquin — Python SDK

**Shape:** SDK + `recipe.yaml` + `artifacts/` folder.

```bash
# from aqfw checkout
pip install -e ./sdk
# kernel deps (sklearn / torch / …) — same Python as the kernel:
pip install -r aq/kernel/requirements.txt
# recommended: install into the kernel venv
aq/kernel/.venv/bin/pip install -e ./sdk
```

```python
from aquin import Aquin

aq = Aquin("tests/sdk-ridge")  # or path to recipe.yaml / any tests/<train>
aq.train()
aq.eval()
print(aq.status())
```

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.

Design: [`internals/author/sdk-first.md`](../internals/author/sdk-first.md) · trains: [`tests/`](../tests/README.md) · minimal: [`tests/sdk-ridge`](../tests/sdk-ridge/).
