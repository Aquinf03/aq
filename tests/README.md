# tests

Manual end-to-end **runs**. Each runnable folder has `recipe.yaml` (+ data / evals as needed). Training writes **`artifacts/`**.

**Identity:** `recipe.yaml` is enough. `experiment.md` is optional.

| Surface | How |
|---------|-----|
| **CLI** | `./aq/bin/aq train tests/<path>` |
| **SDK** | Python in the folder — see [`sdk-ridge/example.py`](sdk-ridge/example.py) |

```bash
aq/kernel/.venv/bin/pip install -e ./sdk
cd aq && npm run build && cd ..

cd tests/sdk-ridge && ../../aq/kernel/.venv/bin/python example.py
```

---

## SDK examples (code + YAML)

| Suite | What it shows |
|-------|----------------|
| [sdk-ridge](sdk-ridge/) | `example.py` + existing `recipe.yaml` |
| [sdk-from-dict](sdk-from-dict/) | `example.py` builds YAML via `from_dict`, then trains |

Other suites are science fixtures (CLI + optional `Aquin("tests/…")` in their README). The **canonical SDK samples** are the two folders above.

---

## Science fixtures

### Tabular / classical

| Suite | Path(s) |
|-------|---------|
| [linear-regression](linear-regression/) | `linear-regression` |
| [logistic-regression](logistic-regression/) | `logistic-regression` |
| [ridge](ridge/) | `ridge` |
| [lasso](lasso/) | `lasso` |
| [elastic-net](elastic-net/) | `elastic-net` |
| [decision-trees](decision-trees/) | `decision-trees` |
| [random-forests](random-forests/) | `random-forests` |
| [gradient-boosting](gradient-boosting/) | `gradient-boosting` |
| [gaussian-processes](gaussian-processes/) | `gaussian-processes` |

### Transformers / tokenizers / packing

| Suite | Path(s) |
|-------|---------|
| [transformers](transformers/) | `decoder`, `encoder`, `encoder-decoder` |
| [tokenizer-in-train](tokenizer-in-train/) | `tokenizer-in-train` |
| [tokenizer-algorithms](tokenizer-algorithms/) | `byte`, `bpe`, `wordpiece`, `unigram` |
| [pack-mixture](pack-mixture/) | `pack-mixture` |

### Foundation / LM

| Suite | Path(s) |
|-------|---------|
| [ar-pretrain](ar-pretrain/) | `ar-pretrain` |
| [masked-pretrain](masked-pretrain/) | `mlm`, `span` |
| [mtp-pretrain](mtp-pretrain/) | `mtp-pretrain` |
| [fim-pretrain](fim-pretrain/) | `fim-pretrain` |
| [continued-pretrain](continued-pretrain/) | `base` then `continue` |
| [sft](sft/) | `base` then `tune` |
| [full-ft](full-ft/) | `base` then `tune` |
| [lora](lora/) | `base` then `tune` |
| [qlora](qlora/) | `base` then `tune` (CUDA) |
| [serve-checkpoint](serve-checkpoint/) | train then `serve` |

### Vision / VLM

| Suite | Path(s) |
|-------|---------|
| [cnn-vision](cnn-vision/) | `cnn-vision` |
| [vit-vision](vit-vision/) | `vit-vision` |
| [vlm-clip](vlm-clip/) | `vlm-clip` |
| [vlm-llava](vlm-llava/) | `vlm-llava` |

### Safety / agent

| Suite | Path(s) |
|-------|---------|
| [guard-safety](guard-safety/) | `good`, `bad` |
| [aq-agent-internal-evals](aq-agent-internal-evals/) | agent probes |

Kernel deps: `pip install -r aq/kernel/requirements.txt` (prefer `aq/kernel/.venv`).
