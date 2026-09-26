# aquin — Python SDK

**Shape:** **`recipe.yaml` (path map) + runtime dirs.**  
Defaults: `artifacts/` + `evals/`. Override with `paths:` (YAML) or `paths=` / `artifacts=` (SDK).  
Author with **YAML** and/or the **SDK** — both are first-class; pick either (or mix).

```bash
pip install -e ./aq
pip install -r aq/kernel/requirements.txt
```

## Few-line tracking (any script)

W&B / MLflow-shaped. One call turns on framework hooks; metrics live in the train folder
(`artifacts/metrics.jsonl` + `artifacts/runs/<id>.json`) — same store as `aq train`.

```python
from aquin import autolog, log_params, log_metric, set_tags, finish

autolog(train=".")              # hooks + metrics session
log_params({"lr": 1e-3})        # or log_param("lr", 1e-3)
# … your Trainer.fit / model.fit / loop …
log_metric("loss", 0.4, step=10)
set_tags("baseline")
finish()                        # writes runs/<id>.json
```

Also automatic inside `aq train` / `Aquin.train()` — no extra call required.  
Example: [`scripts/tests/sdk-track`](../scripts/tests/sdk-track/).

## System metrics (GPU / CPU / mem / disk / net)

Opt-in vitals beside loss curves (metrics.jsonl + train/eval TUI).

```bash
aq train --system
aq eval --system
```

```yaml
# recipe.yaml
capture:
  system: true
```

```python
from aquin import Aquin, autolog, log_system, start_system, finish

aq = Aquin(".")
aq.train(system=True)           # or aq.eval(...,) via CLI flag

# standalone script:
autolog(train=".", system=True) # background sampler
log_system()                    # one-shot sample
start_system(interval=2.0)
finish()
```

## Gradient & param norms

Opt-in train-dynamics debug (global ‖g‖ / ‖θ‖ + mean/std; top layers). Auto from HF Trainer
and torch `Optimizer.step` — no custom hooks. Skips sklearn.

```bash
aq train --grads
```

```yaml
capture:
  grads: true
  grads_every: 25   # optional (default 50)
```

```python
from aquin import Aquin, enable_grads, log_grads

aq = Aquin(".")
aq.train(grads=True)

# manual (own torch loop):
enable_grads(every=10)
log_grads(model, step=100)
```

## Tables (predictions / errors)

One call logs a row with **any** columns; aq owns the JSONL. Browse with an interactive CLI.

```python
from aquin import table

table(y=1, yhat=0, loss=0.9, note="whatever you want")  # default table
table("preds", id=i, y=y, yhat=yhat, err=e, text=t)     # named
table("errors", path=p, score=s, tag="hard")            # another table — any fields
```

```bash
aq plot table              # default / only table
aq plot table preds        # one named table
aq plot table all          # everything logged (adds _table column)
aq plot table all --run <id>
```

TUI: `↑↓` scroll · `/` or `Ctrl+F` find · `s` sort · `c` clear · `q` quit.  
Example: [`scripts/tests/sdk-table`](../scripts/tests/sdk-table/).

## Infra events (OOM / preempt / disk on the loss timeline)

Discrete host/GPU/scheduler incidents stamped onto the **same** `metrics.jsonl` as loss — not a separate ops dashboard.

Auto: CUDA OOM / device errors in train/eval, VLM OOM retry, low disk (when `--system`), fleet `aq jobs recover` (`AQ_RECOVERED` → `preempt`/`retry` on restart).

```python
from aquin import autolog, log_infra, finish

autolog(train=".")
log_infra("gpu", "Xid 79", xid=79, step=12400)
# … or let aq stamp OOM / recover for you …
finish()
```

Kinds: `oom`, `gpu`, `preempt`, `node`, `disk`, `net`, `retry`, `signal`.  
TUI shows an `infra` badge + ▼ under the loss chart; `aq plot metrics` draws vertical markers.

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
# optional — use your own folder names
paths:
  artifacts: out
  evals: probes
```

```python
from aquin import Aquin

aq = Aquin(".")  # reads recipe.yaml (+ paths:)
aq.train()
aq.eval()
```

```bash
aq train && aq eval
```

`aq sync` pushes the whole run folder; `aq jobs pull` merges remote `paths.artifacts` into the local runtime dir.

## Option B — author in Python (writes the same path map)

```python
from aquin import Aquin

aq = Aquin.define(
    family="tabular",
    method="linear",
    data={"path": "data.csv", "target": "y"},
    eval={"metric": "mse"},
    paths={"artifacts": "out", "evals": "probes"},
    config_path="recipe.yaml",
)
# or: artifacts="out"  # shorthand → paths.artifacts
aq.train()
aq.eval()
```

Optional class style: `Run` → same `recipe.yaml`.

## Autolog (framework integrations)

One call turns on hooks for whatever ML libs are importable. Metrics land in `artifacts/metrics.jsonl` (same store as `aq train`).

```python
from aquin import autolog, frameworks

autolog()                       # all available: sklearn, transformers, xgboost, …
# autolog("sklearn", "xgboost") # subset
print(frameworks())             # catalog + active hooks
```

Also automatic inside `aq train` / `Aquin.train()` — no extra call required.

| Adapter | What it hooks |
|---------|----------------|
| sklearn | `BaseEstimator.fit` → params + train MSE step when possible |
| transformers | `Trainer` gets aq metrics callback |
| xgboost / lightgbm / catboost | fit callbacks / post-fit params |
| keras / tensorflow | `Model.fit` epoch callback |
| pytorch-lightning | Trainer logger |
| spark / pyspark | `pyspark.ml.Estimator.fit` → params (+ summary loss when present) |
| torch | only if `AQ_TORCH_AUTOLOG=1` (Optimizer.step heartbeat) |

## Params / metrics / tags / notes

Explicit logging API (W&B / MLflow-shaped). Same folder store: `metrics.jsonl` + `runs/<id>.json`.

```python
from aquin import Aquin, log_param, log_params, log_metrics, set_tags, set_notes, finish

aq = Aquin(".")
aq.log_params({"lr": 1e-3, "batch": 32})
aq.log_param("seed", 0)
aq.log_metrics({"loss": 0.42, "acc": 0.91}, step=10)
aq.set_tags("baseline", "gpu")
aq.set_notes("lower LR after loss spike")

# module-level (uses cwd run or active session):
log_params({"seed": 0})
log_param("wd", 1e-4)
log_metrics({"val_loss": 0.5}, step=10)
set_tags("ablation")
set_notes("…")
finish()   # standalone sessions → runs/<id>.json
```

## Logged models

`aq train` stamps a content-addressed **logged model** id on the checkpoint (`aq_model_id`),
the run (`model.id` + `model.checkpoint` + `model.data_hash`), and metric events
(`logged_model`, `checkpoint`, `data_hash`). Distinct from HF hub `model_id`.

```python
from aquin import log_model

log_model()                              # last checkpoint
log_model("artifacts/checkpoints/3.json")
```

## Plot

```python
from aquin import Aquin
aq = Aquin(".")

aq.plot("metrics", fields=["loss", "lr"], style="line", title="loss")
aq.plot("samples", max=32, nrow=4, from_dirs="artifacts/samples")
aq.plot(charts=["metrics", "samples"], dpi=200)
```

Same knobs as CLI (`aq plot metrics --fields loss --style line`) and `recipe.yaml`:

```yaml
plot:
  charts: [metrics, samples]
  metrics:
    fields: [loss, lr]
    style: line
    figsize: [7, 4]
  samples:
    max: 64
    nrow: 8
    backend: auto
```

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

Shared GPUs on one box:

```bash
aq jobs run --on box --gpu 1 -- python train.py   # claims one free GPU
aq jobs run --on box --gpu 1 -- python train.py   # another free GPU
aq jobs run --on box --devices 0,2 -- …           # pin indices
aq places   # shows e.g. 6/8gpu free
```

Managed recovery (auto retry after flake/preempt):

```bash
aq jobs run --on gpus --manage --retry 3 --prefer next -- aq train
aq jobs watch              # polls all managed jobs
aq jobs manage <id> --retry 5 --prefer same
```

Sweeps (many independent jobs across a place/pool):

```bash
aq jobs sweep --shard 8 --on gpus -- aq train --shard {i}/{n}
aq jobs sweep --grid lr=1e-3,1e-4 --grid wd=0,1e-4 --on gpus -- python train.py --lr {lr} --wd {wd}
aq jobs sweep --shard 4 --grid lr=1e-3,1e-4 --manage --prefer next --on gpus -- …
aq jobs list --tag sweep=<id>
```

```python
from aquin import Place
p = Place("gpus")
out = p.sweep(["aq", "train", "--shard", "{i}/{n}"], shard=8, manage=True)
# out["sweep"], out["jobs"], out["total"]
```

Placeholders in the command: `{i}` `{n}` `{shard}` `{shards}` plus each `--grid` key.
Env on each job: `AQ_SWEEP`, `AQ_SHARD`, `AQ_SHARDS`, `AQ_SWEEP_I`, `AQ_SWEEP_N`, and `AQ_<GRIDKEY>`.

Examples: [`scripts/tests/sdk-ridge`](../scripts/tests/sdk-ridge/) (YAML-first), [`scripts/tests/sdk-from-dict`](../scripts/tests/sdk-from-dict/) / [`scripts/tests/sdk-run-class`](../scripts/tests/sdk-run-class/) (SDK-first), [`scripts/tests/sdk-track`](../scripts/tests/sdk-track/) (few-line tracking).

Set `AQ_KERNEL` to `aq/kernel` if discovery fails.
