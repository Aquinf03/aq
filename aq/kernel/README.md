# kernel

Python. Train, eval, serve, checkpoint, data hash. Spec is **`recipe.yaml`**. Built-ins need no custom Python.

```
run.py
backends/       real stacks (HF, sklearn, device, deploy, tok_train)
protocol/       recipe, revision, record, metrics, guard, method loader,
                autolog, sysmetrics, grads, tables, infra, eval_suite, …
engine/         train / eval / serve / checkpoint
methods/        thin adapters; filename = recipe.method
plot/           metrics / jobs / runs / samples / table TUI / eval suite charts
requirements.txt
```

```bash
pip install -r aq/kernel/requirements.txt
# aq prefers aq/kernel/.venv/bin/python when present
```

## Observability (folder-first)

| Module | Events / artifacts |
|--------|-------------------|
| `protocol/metrics` | `artifacts/metrics.jsonl` + train/eval TUI |
| `protocol/sysmetrics` | `system` vitals (`--system` / `capture.system`) |
| `protocol/grads` | `grads` norms (`--grads`) |
| `protocol/infra` | `infra` OOM/preempt/… on the loss timeline |
| `protocol/eval_suite` | `eval.suite` / `eval.plot` / `eval.extra` + `artifacts/plots/` |
| `protocol/tables` | `artifacts/tables/<name>.jsonl` (`aquin.table`) |

SDK surface: [aq/SDK.md](../SDK.md). Shipped checklist: [internals/COMPLETED.md](../../internals/COMPLETED.md).

## Contract

- `recipe.model` **required** for llm / lora / qlora / transformer.
- `size:` is a label only.
- QLoRA = CUDA + bitsandbytes only (errors elsewhere).
- Unsupported: `paged_kv` (recorded; serve not paged yet). `objective: mtp` needs `n_predict >= 2`. `speculative: true` needs `draft_model:`. `formats:` exports real packs (GGUF / GPTQ / AWQ / EXL2) — see recipe docs.
- Vision: `family: vision` / `method: cnn` — aq-owned CNNs under `neural/cnn/` (Pillow required).
- Vision: `family: vision` / `method: vit` — aq-owned ViT / Swin / DeiT / BEiT under `neural/vit/`.
- VLM: `family: vlm` / `method: clip|llava|flamingo` — CLIP/SigLIP aq-owned; LLaVA/Flamingo aq connectors + causal LM.
- Devices: CUDA, MPS, ROCm, CPU.
- Tabular eval suite on by default (`evaluate()` / `aq eval --suite`); extras via kwargs or `eval.extra: [name]` → `scorers.py`.

See [Recipe docs](https://aquinf03.github.io/aq/documentation/) and [internals/COMPLETED.md](../../internals/COMPLETED.md).
