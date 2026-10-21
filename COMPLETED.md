# What ships in aq

Public inventory of **working** framework surface — recipe + real libraries, not stubs.  
Companion docs: [documentation](https://aquinf03.github.io/aq/documentation/) · [templates](https://aquinf03.github.io/aq/documentation/templates/) · [SDK](./aq/SDK.md) · [changelog](./CHANGELOG.md)

The experiment is a **directory**: `recipe.yaml` (path map) + `artifacts/` (runtime). Author with YAML and/or the `aquin` SDK.

| Area | Shipped |
|------|---------|
| **Core protocol** | Train folder, CLI, local jobs, Python kernel, eval gate |
| **Tracking** | Autolog, TUI / `aq track`, metrics, run records, classical eval suite |
| **Artifacts** | Catalog, aliases, promote/webhooks, lineage, logged models |
| **Compute** | SSH places → jobs → pools |
| **Serve** | one-shot `aq serve` + durable `aq serve --api` (local REST); SDK `load` + `predict` |
| **Methods** | Tabular, transformers, LLM/LoRA/QLoRA, vision, VLM |

---

## Core protocol

### Directory

- Train folder schema (`recipe.yaml`, optional slots)
- `aq init` scaffolds a run you can grow
- `aq fork` copies the tree (skips `jobs/` and `artifacts/`)
- Empty slots stay valid (skills, tools, evals, …)

### CLI (`aq`)

- `aq help` · `aq init` / `aq fork`
- `aq login` / `logout` / `switch` ([aquin.app/aq](https://aquin.app/aq))
- `aq update` / `aq version`
- `aq train` · `aq eval` · `aq status` · `aq diff` · `aq track` · `aq plot`

### Local jobs

- `aq job run | list | log | cancel | resume | tree`
- Subprocess jobs under `jobs/`, resource asks, survive disconnects

### Kernel (Python)

- Data revision (hash, optional snapshot)
- Train / eval / checkpoint / serve via files + JSON
- Recipe is the spec — built-ins need no custom Python
- Live metrics on stderr + `artifacts/metrics.jsonl`
- Opt-in `guard.safety` / `guard.leak`
- Install: `pip install -r aq/kernel/requirements.txt` (venv preferred)

### Eval gate

- User probes in `evals/`; humans own the gate
- Tools / skills / MCP / schedules as train-folder slots
- Run records, diff, status

---

## Tracking & experiment capture

Id = train folder + `artifacts/runs/<id>.json`. Browse with `aq track`.

### Experiment capture & autolog

- After `aq train` / `aq eval`: run id + loss sparkline; `aq train --tracker` for live TUI
- Auto-log params, metrics, console, artifacts from framework hooks (sklearn, HF Trainer, …)
- Opt-in **code tree** capture → `artifacts/code/tree.tgz` (`capture.code` / `--capture-code`)
- Opt-in **env** capture → `artifacts/env/` (`capture.env: lock|full`)
- Framework adapters: sklearn, transformers, xgboost, lightgbm, catboost, keras/TF, pytorch-lightning, spark ML; raw torch via `AQ_TORCH_AUTOLOG=1`
- Few-line SDK: `autolog` / `log_param(s)` / `log_metric(s)` / tags / notes / `finish` — see [`scripts/tests/sdk-track`](./scripts/tests/sdk-track/)

### Params, data, live metrics

- Params / metrics / tags / notes on run records + `metrics.jsonl`
- Rich **data revision**: `aq data hash` → `data/revision.json` + `data_hash` on runs
- Step curves in the train TUI; `aq plot metrics` for files
- System metrics (CPU/GPU/mem/…) via `--system` / `capture.system`
- Gradient & param norms via `--grads` / `capture.grads`
- Tables: `aquin.table(...)` → `artifacts/tables/`; `aq plot table`
- Infra events (oom / preempt / …) on the metrics timeline; fleet `recover` stamps them

### Classical ML evaluation

- `aquin.evaluate(...)` (+ `aq eval --suite`) → suite metrics + plots under `artifacts/plots/`
- Extra metrics via kwargs / recipe `eval.extra`
- Copy-paste **templates** (ingest → train → eval → register): [docs/templates](https://aquinf03.github.io/aq/documentation/templates/)
- **Logged models** — content-addressed ids linked to checkpoint + dataset; SDK `log_model()`

---

## Artifacts, registry & lineage

- Logged models (stable ids ↔ checkpoint + data hash)
- Data revision on runs
- Run records: `artifacts/runs/<id>.json` · `aq diff` · `aq status` · `aq track`
- **Lineage** — `aq lineage` / `aquin.lineage()` / `model.lineage()`: model → run → data (who trained these weights)
- **Catalog** — `artifacts/catalog/` content-addressed entries (model/data/code/run) with parent links; `aq artifacts` / `Aquin.catalog()`
- **Aliases** — `latest` / `best` / custom pointers (`aq artifacts alias`, `load("prod")`)
- **Promote + webhooks** — `aq artifacts promote [prod] [ref]` fires `artifacts.webhooks` (create/alias/promote) for CI/CD / Slack / deploy; events in `catalog/events.jsonl`
- **Flow `self.x`** — `@step` flows persist assignments under `artifacts/flow/`; next step reads them with no manual save/load
- **Flow local ↔ remote** — `@step(place=\"gpu\")` runs on a fleet place; `aq sync` / `jobs pull` are automatic (same artifact paths)
- **Flow step freeze + resume** — each step writes `done/`, `snapshots/`, `steps.json`; `Flow().run(resume=True)` clones into a new run and continues
- **`origin_pathspec`** — resume stamps lineage on the new run + cloned artifacts (`Prep/<run_id>/<step>`); `flow.origin_pathspec` / `summary["origin_pathspec"]`; `clone=False` for in-place
- **`@retry`** — `times` + `minutes_between_retries`; each attempt under `attempts/<step>/<n>/`; **only the successful attempt** is promoted to visible `artifacts/` (`times=0` = no retry)
- **Cross-flow reuse** — `self.import_from("Prep", "rows")` / `self.input(...)` / `open_flow_artifacts(...)`; stamps `origin_pathspec` + `imports.jsonl`
- **`runs` → step → try → art** — archaeology handles over flow folders (`runs("Prep").latest.art("rows")`); `.latest` / `.latest_ok`; iterate runs/steps; `.try_(n)` for retry forensics
- **Pathspecs everywhere** — `at("Prep/<run>/heavy#rows")` / `aq at` resolve to run / step / try / value (same address as `origin_pathspec`)
- **Flow-run tags** — `Flow().run(tags=[…])` / `run.add_tags` / `replace_tags` / `remove_tags`; `sys:…` protected; `runs("Prep", tags=["env=prod"])` AND-filter
- **Step loglines** — stdout/stderr captured under `logs/` with timestamps; `step.stdout` / `.stderr` / `.loglines`; `aq logs <pathspec>` (no SSH)
- **`aq find`** — locate flow / catalog / checkpoint / run artifacts by name (CLI, not a Python object tree)
- **Flow CAS** — `self.x` blobs under `cas/` by `sha256:…` (dedupe); pointers in `artifacts/`; `aq artifacts verify` / `flow.verify()`
- **Flow code package** — each run writes `code/tree.tgz` (FlowSpec + aquin); `flow.code` → sha / path / file list

---

## Compute, fleets & scheduling

Laptop is the control plane; jobs run on **your** machines over SSH.

- Places — `aq add ssh` / `aq places`
- Launch / go / sync / shutdown; shell via `aq go` / `aq launch --shell`
- Jobs — train | eval | serve / list / status / logs / pull
- Python `Place` / `Job` / `Queue` (`aquin.fleet`)
- Pools, multi-node (`--nodes`), recover, queues, ports, tags, GPU pin, managed retries, sweeps

---

## Serve & inference

- `aq serve` one-shot on a checkpoint (method-native path)
- **`aq serve --api`** — durable local REST (`/predict`, `/generate`, `/health`) until Ctrl-C; `--port` / `--host` / `--ckpt`
- **SDK load + predict** — `from aquin import load` → `model.predict(x)` (last / path / step / sha256; joblib when present)

---

## Training stack & methods

### Vision (`family: vision`)

- CNN families (LeNet → ConvNeXt) and ViT / Swin / DeiT / BEiT

### Vision–language (`family: vlm`)

- CLIP / SigLIP · LLaVA-style · Flamingo

### Tabular (scikit-learn; boosting prefers XGBoost → LightGBM → CatBoost)

- Linear, logistic, ridge, lasso, elastic net, trees, forests, boosting, Gaussian processes

### Transformers (Hugging Face; `recipe.model` required)

- Encoder / decoder / encoder-decoder on CUDA, MPS, ROCm, or CPU

### LLM / foundation (HF + PEFT)

- Tokenizer in-train (incl. local BPE / Unigram / WordPiece / byte)
- Pack / mixture / context windows
- Objectives: next-token, MLM, span, FIM, continued-pretrain, SFT, full-ft, LoRA, QLoRA (CUDA), MTP
- Live Trainer metrics; prune / quant dump; GPTQ / AWQ / GGUF / EXL2 export; speculative decode with draft model

---

## Try it

```bash
curl -fsSL https://github.com/Aquinf03/aq/releases/latest/download/install.sh | bash
aq init demo && cd demo
# edit recipe.yaml → data.path
aq train && aq eval && aq status
```

Or SDK: see [aq/SDK.md](./aq/SDK.md) and [`scripts/tests/sdk-ridge`](./scripts/tests/sdk-ridge/).
