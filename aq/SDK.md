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

## Fleet (SSH place) — same jobs from Python

```python
from aquin import Place

p = Place("temp")
j = p.train()                 # or p.eval() / p.serve() / p.run(["sleep", "10"])
print(j.id, j.status()["status"])
print(j.logs())
j.pull()
# j.recover()                 # same id after SSH/host death; --next via pool
```

CLI twin: `aq jobs train --on temp` (same as `aq jobs run --on temp -- aq train`).

Pools: `aq add pool gpus box1 box2` then `Place("gpus")` / `--on gpus` picks a free member.

Multi-node: `p.train(nodes=2)` or `aq jobs train --on gpus --nodes 2` (sets RANK / WORLD_SIZE / MASTER_ADDR).

Recover: `aq jobs recover <id>` (same box) · `--next` / `--on <pool>` when the host is gone.

Queues:

```bash
aq queue add gpus --on gpus
aq queue push gpus --priority 10 -- aq train
aq queue worker gpus --once   # or leave running
```

```python
from aquin import Queue
j = Queue("gpus").submit(["aq", "train"], priority=10)
```

Sync / shutdown:

```bash
aq sync --on temp          # push local folder (like git push to the box)
aq shutdown                # stop jobs + clear session
aq shutdown --wipe         # also delete remote run dir
```

Ports (SSH tunnel to a remote UI):

```bash
aq port 8000 --on temp --bg
aq jobs run --on temp --port 8000 -- python -m http.server 8000
aq launch --on temp --port 6006   # interactive + LocalForward
```

Tags (local governance):

```bash
aq tag place temp team=ml env=prod
aq tag job <id> exp=lr-sweep
aq places --tag team=ml
aq jobs list --tag exp=lr-sweep
aq jobs run --tag exp=baseline --on temp -- sleep 10
```

Examples: [`scripts/tests/sdk-ridge`](../scripts/tests/sdk-ridge/) (YAML-first), [`scripts/tests/sdk-from-dict`](../scripts/tests/sdk-from-dict/) / [`scripts/tests/sdk-run-class`](../scripts/tests/sdk-run-class/) (SDK-first).

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.
