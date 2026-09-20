"""Real causal / masked LM train from recipe.yaml (Hugging Face + PEFT).

Devices: CUDA, ROCm (AMD), MPS (Apple), CPU.
recipe.model or recipe.size → hub id. No toy weight fallback.
"""

from __future__ import annotations

from protocol.paths import ckpt_dir
import csv
import json
import random
import sys
from pathlib import Path
from typing import Any

from backends import deploy as deploy_mod
from backends.device import (
    apply_pretrained_dtype,
    cuda_alloc_hygiene,
    default_dtype,
    device_kind,
    model_load_dtype,
    move_batch,
    resolve_train_precision,
    supports_bnb_4bit,
    torch_device,
)
from backends.deps import require_peft, require_torch, require_transformers
from backends.recipe_opt import opt
from backends.tok_train import ensure_mask_token, ensure_pad_token, load_hf_tokenizer, train_tokenizer


def resolve_model_id(rec: dict, *, arch: str = "causal") -> str:
    mid = opt(rec, "model", None, "init", "pretrained", "llm")
    if mid:
        return str(mid)
    init = rec.get("init") if isinstance(rec.get("init"), dict) else {}
    mid = init.get("model") or init.get("pretrained") or init.get("base")
    if mid:
        return str(mid)
    raise SystemExit(
        "recipe.model is required (Hugging Face id or local path). "
        "size: is only a label (llm|slm|edge); it does not pick weights. "
        "Example: model: meta-llama/Llama-3.2-1B-Instruct"
    )


def _train_root(rec: dict) -> Path:
    t = rec.get("_train")
    if not t:
        raise SystemExit("internal: fit needs _train (engine bug)")
    return Path(t)


def _ckpt_slot(rec: dict) -> Path:
    root = _train_root(rec)
    dest = ckpt_dir(root)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name != "last.json")
    slot = dest / str(n)
    slot.mkdir(parents=True, exist_ok=True)
    return slot


def _load_rows(path: Path) -> list[dict]:
    if path.suffix == ".jsonl":
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _texts_from_data(src: Path, rec: dict) -> tuple[list[str], list[str] | None]:
    """Return texts and optional mixture source tags."""
    data = rec.get("data") or {}
    rows = _load_rows(src)
    if not rows:
        raise SystemExit(f"empty data: {src}")
    prompt_k = data.get("prompt") or data.get("instruction")
    comp_k = data.get("completion") or data.get("output") or data.get("response")
    text_k = data.get("text") or data.get("target")
    source_k = data.get("source")
    out: list[str] = []
    sources: list[str] = []
    for r in rows:
        if prompt_k and comp_k and prompt_k in r and comp_k in r:
            out.append(str(r[prompt_k]).rstrip() + "\n" + str(r[comp_k]).lstrip())
        elif text_k and text_k in r:
            out.append(str(r[text_k]))
        else:
            for k, v in r.items():
                if isinstance(v, str) and v.strip() and k != source_k:
                    out.append(v)
                    break
        if source_k:
            sources.append(str(r.get(source_k) or "default"))
    if not out:
        raise SystemExit("no text rows — set data.text, or data.prompt + data.completion")
    return out, (sources if source_k else None)


def _pack_mixture(texts: list[str], sources: list[str] | None, rec: dict, max_len: int, tok) -> list[str]:
    """Weighted mixture + pack short docs into context windows."""
    mixture = rec.get("mixture")
    if isinstance(mixture, dict) and sources and len(sources) == len(texts):
        weights = {str(k): float(v) for k, v in mixture.items()}
        buckets: dict[str, list[str]] = {}
        for t, s in zip(texts, sources):
            buckets.setdefault(s, []).append(t)
        rng = random.Random(int(opt(rec, "seed", 0) or 0))
        n = len(texts)
        picked: list[str] = []
        keys = [k for k in weights if k in buckets and buckets[k]]
        if not keys:
            keys = list(buckets)
        total_w = sum(weights.get(k, 1.0) for k in keys) or 1.0
        for _ in range(n):
            r = rng.random() * total_w
            acc = 0.0
            choice = keys[0]
            for k in keys:
                acc += weights.get(k, 1.0)
                if r <= acc:
                    choice = k
                    break
            picked.append(rng.choice(buckets[choice]))
        texts = picked

    # pack: concatenate until near max_len chars heuristic
    if opt(rec, "pack", True, "train", "llm") is False:
        return texts
    packed: list[str] = []
    buf = ""
    # rough char budget from tokenizer length
    char_budget = max_len * 3
    for t in texts:
        if len(buf) + len(t) + 1 <= char_budget:
            buf = (buf + "\n" + t).strip()
        else:
            if buf:
                packed.append(buf)
            buf = t
    if buf:
        packed.append(buf)
    return packed or texts


def _objective(rec: dict, method_name: str | None = None) -> str:
    obj = str(opt(rec, "objective", "") or "").lower().replace("_", "-")
    if obj:
        return obj
    m = (method_name or str(rec.get("method") or "")).lower().replace("-", "_")
    if m in ("lora", "qlora"):
        return m
    if _use_qlora_flag(rec):
        return "qlora"
    data = rec.get("data") or {}
    if (data.get("prompt") or data.get("instruction")) and (
        data.get("completion") or data.get("output")
    ):
        return "sft"
    return "next-token"


def _use_qlora_flag(rec: dict) -> bool:
    bits = opt(rec, "bits", None, "quantization")
    if bits in (4, "4", True):
        return True
    q = rec.get("quantization")
    if isinstance(q, dict) and (q.get("load_in_4bit") or q.get("bits") == 4):
        return True
    return False


def _load_mlm_model(transformers, model_id: str, load_kw: dict[str, Any]) -> tuple[Any, bool]:
    """Load encoder MLM or fall back to causal LM with masked-token loss."""
    try:
        return transformers.AutoModelForMaskedLM.from_pretrained(model_id, **load_kw), False
    except Exception as e:
        msg = str(e).lower()
        if "maskedlm" in msg.replace("_", "") or "not supported" in msg:
            print(
                f"  mlm  {model_id!r} has no MaskedLM head — causal LM + masked-token loss",
                file=sys.stderr,
            )
            return transformers.AutoModelForCausalLM.from_pretrained(model_id, **load_kw), True
        raise SystemExit(f"objective mlm failed to load {model_id!r}: {e}") from e


def _build_model_and_tok(rec: dict, obj: str, slot: Path, texts: list[str]):
    torch = require_torch()
    transformers = require_transformers()
    model_id = resolve_model_id(rec)
    want_qlora = obj == "qlora" or _use_qlora_flag(rec)
    dtype = default_dtype(rec)
    kind = device_kind()

    # Optional train-local tokenizer algorithm
    tok_algo = opt(rec, "tokenizer", opt(rec, "tok", None), "llm")
    local_tok = None
    tok_meta = None
    if tok_algo and str(tok_algo).lower() not in ("hf", "auto", "none"):
        tok_dir = slot / "tokenizer"
        tok_meta = train_tokenizer(texts, rec, tok_dir)
        local_tok = tok_dir

    tok, resize_emb = load_hf_tokenizer(model_id, local_tok)
    mlm_causal = False

    load_kw: dict[str, Any] = {"trust_remote_code": True}
    qlora_engine = None

    if want_qlora and supports_bnb_4bit():
        from transformers import BitsAndBytesConfig

        load_kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_quant_type=str(opt(rec, "quant_type", "nf4", "quantization")),
            bnb_4bit_use_double_quant=bool(opt(rec, "double_quant", True, "quantization")),
        )
        load_kw["device_map"] = opt(rec, "device_map", "auto")
        qlora_engine = "bitsandbytes"
    elif want_qlora:
        raise SystemExit(
            f"QLoRA needs CUDA + bitsandbytes (this device is {kind}). "
            "Use objective/method lora without bits, or run on NVIDIA CUDA."
        )
    else:
        # VRAM-safe dtypes (bf16 weights + bf16 AMP; never fp32 masters for AMP).
        apply_pretrained_dtype(load_kw, model_load_dtype(rec))
        load_kw["low_cpu_mem_usage"] = True
        # Single-GPU Trainer: avoid device_map=auto (can pin the whole card before step 0).
        # QLoRA keeps device_map above.

    # Model class by objective
    if obj in ("mlm", "masked", "masked-lm"):
        if ensure_mask_token(tok):
            resize_emb = True
        model, mlm_causal = _load_mlm_model(transformers, model_id, load_kw)
    else:
        model = transformers.AutoModelForCausalLM.from_pretrained(model_id, **load_kw)

    if resize_emb:
        model.resize_token_embeddings(len(tok))

    if kind == "mps" and "device_map" not in load_kw:
        model.to(torch_device())
    elif kind in ("cuda", "rocm") and "device_map" not in load_kw:
        model.to(torch_device())
    elif kind == "cpu" and "device_map" not in load_kw:
        model.to(torch_device())

    peft_obj = obj in ("lora", "qlora") or bool(opt(rec, "rank", None, "lora", "peft")) or want_qlora
    used_lora = False
    if peft_obj:
        peft = require_peft()
        if qlora_engine == "bitsandbytes":
            model = peft.prepare_model_for_kbit_training(model)
        rank = int(opt(rec, "rank", 16, "lora", "peft") or 16)
        alpha = int(opt(rec, "alpha", 32, "lora", "peft") or 32)
        dropout = float(opt(rec, "dropout", 0.05, "lora", "peft") or 0.05)
        targets = opt(rec, "target_modules", "all-linear", "lora", "peft")
        # FEATURE_EXTRACTION isn't ideal for MLM+LoRA; skip peft for pure MLM unless rank set
        if obj in ("mlm", "masked", "masked-lm") and not opt(rec, "rank", None, "lora", "peft"):
            model.train()
        else:
            cfg = peft.LoraConfig(
                r=rank,
                lora_alpha=alpha,
                lora_dropout=dropout,
                bias="none",
                task_type="CAUSAL_LM",
                target_modules=targets,
            )
            try:
                model = peft.get_peft_model(model, cfg)
                used_lora = True
            except Exception as e:
                raise SystemExit(
                    f"LoRA/PEFT failed for {model_id!r} (check target_modules / model type): {e}"
                ) from e
    else:
        model.train()

    # Activation checkpointing after PEFT wrap (opt-in; default off for speed).
    want_ckpt = bool(opt(rec, "gradient_checkpointing", False, "train", "llm"))
    if want_ckpt and hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()
        if hasattr(model, "config"):
            try:
                model.config.use_cache = False
            except Exception:
                pass
        if hasattr(model, "enable_input_require_grads"):
            try:
                model.enable_input_require_grads()
            except Exception:
                pass

    return model, tok, model_id, want_qlora, used_lora, qlora_engine, tok_meta, mlm_causal


def _fim_texts(texts: list[str], rng: random.Random) -> list[str]:
    out = []
    for t in texts:
        if len(t) < 8:
            out.append(t)
            continue
        i = rng.randint(1, max(1, len(t) // 3))
        j = rng.randint(i + 1, max(i + 1, (2 * len(t)) // 3))
        prefix, middle, suffix = t[:i], t[i:j], t[j:]
        # PSM order
        out.append(f"<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>{middle}")
    return out


def _span_corrupt(texts: list[str], rng: random.Random, rate: float = 0.15) -> list[tuple[str, str]]:
    """Return (corrupted_input, original) pairs for span corruption style."""
    pairs = []
    for t in texts:
        words = t.split()
        if len(words) < 4:
            pairs.append((t, t))
            continue
        n_span = max(1, int(len(words) * rate))
        start = rng.randint(0, max(0, len(words) - n_span))
        masked = words[:start] + ["[MASK]"] + words[start + n_span :]
        pairs.append((" ".join(masked), t))
    return pairs


def _build_dataset(torch, tok, texts: list[str], rec: dict, obj: str, max_len: int, src: Path | None = None):
    rng = random.Random(int(opt(rec, "seed", 0) or 0))
    mask_rate = float(opt(rec, "mask_rate", 0.15, "llm") or 0.15)

    if obj in ("mtp", "multi-token", "multi-token-prediction"):
        from backends.mtp import build_mtp_rows, n_predict_from_rec

        n_p = n_predict_from_rec(rec)
        rows = build_mtp_rows(tok, texts, max_len, n_p)
        return _list_dataset(torch, rows)

    if obj in ("fim", "fill-in-the-middle", "fill-in-middle"):
        texts = _fim_texts(texts, rng)

    if obj in ("sft", "supervised", "supervised-finetune", "full-ft", "full-finetune", "full-fine-tune"):
        if src is None:
            raise SystemExit("internal: sft dataset needs src")
        return _sft_dataset(torch, tok, src, rec, obj, max_len)

    if obj in ("mlm", "masked", "masked-lm"):
        enc = tok(
            texts,
            truncation=True,
            max_length=max_len,
            padding="max_length",
            return_tensors="pt",
        )
        input_ids = enc["input_ids"].clone()
        labels = input_ids.clone()
        probability_matrix = torch.full(labels.shape, mask_rate)
        special = torch.zeros_like(labels, dtype=torch.bool)
        for i in range(labels.size(0)):
            for j in range(labels.size(1)):
                tid = int(labels[i, j])
                if tid in (tok.pad_token_id, tok.cls_token_id, tok.sep_token_id, tok.bos_token_id, tok.eos_token_id):
                    special[i, j] = True
        probability_matrix.masked_fill_(special, value=0.0)
        masked_indices = torch.bernoulli(probability_matrix).bool()
        labels[~masked_indices] = -100
        # 80% mask token
        indices_replaced = torch.bernoulli(torch.full(labels.shape, 0.8)).bool() & masked_indices
        mask_id = tok.mask_token_id if tok.mask_token_id is not None else tok.unk_token_id
        input_ids[indices_replaced] = mask_id
        indices_random = torch.bernoulli(torch.full(labels.shape, 0.5)).bool() & masked_indices & ~indices_replaced
        random_words = torch.randint(len(tok), labels.shape, dtype=torch.long)
        input_ids[indices_random] = random_words[indices_random]

        class DS(torch.utils.data.Dataset):
            def __len__(self):
                return input_ids.shape[0]

            def __getitem__(self, i):
                return {
                    "input_ids": input_ids[i],
                    "attention_mask": enc["attention_mask"][i],
                    "labels": labels[i],
                }

        return DS()

    if obj in ("span", "span-corruption"):
        pairs = _span_corrupt(texts, rng, mask_rate)
        srcs = [p[0] for p in pairs]
        tgts = [p[1] for p in pairs]
        enc = tok(srcs, truncation=True, max_length=max_len, padding="max_length", return_tensors="pt")
        lab = tok(tgts, truncation=True, max_length=max_len, padding="max_length", return_tensors="pt")
        labels = lab["input_ids"]
        labels[labels == tok.pad_token_id] = -100

        class DS(torch.utils.data.Dataset):
            def __len__(self):
                return labels.shape[0]

            def __getitem__(self, i):
                # causal LM learns to reconstruct; concat mask cue + target shift handled by labels=input
                ids = enc["input_ids"][i]
                return {
                    "input_ids": ids,
                    "attention_mask": enc["attention_mask"][i],
                    "labels": labels[i] if labels.shape == enc["input_ids"].shape else ids.clone(),
                }

        return DS()

    # causal / lora / qlora / cpt / next-token / fim (already rewritten texts)
    rows = []
    for text in texts:
        enc = tok(text, truncation=True, max_length=max_len, padding=False)
        ids = list(enc["input_ids"])
        rows.append(
            {
                "input_ids": ids,
                "attention_mask": list(enc["attention_mask"]),
                "labels": list(ids),
            }
        )
    return _list_dataset(torch, rows)


def _list_dataset(torch, rows: list[dict]):
    class DS(torch.utils.data.Dataset):
        def __len__(self):
            return len(rows)

        def __getitem__(self, i):
            return rows[i]

    return DS()


def _lm_collator(tok):
    """Pad to batch max length — not max_seq_len (matches normal custom SFT scripts)."""
    transformers = require_transformers()
    return transformers.DataCollatorForSeq2Seq(
        tokenizer=tok,
        padding=True,
        label_pad_token_id=-100,
        return_tensors="pt",
    )


def _sft_dataset(torch, tok, src: Path, rec: dict, obj: str, max_len: int):
    """SFT: loss on completion only. Variable-length; collator pads per batch.

    Old path used padding='max_length' for every row → T4 spent most FLOPs on pad
    tokens vs a normal script (~5–10× slower for short JSONL).
    """
    data = rec.get("data") or {}
    prompt_k = data.get("prompt") or data.get("instruction")
    comp_k = data.get("completion") or data.get("output") or data.get("response")
    if not prompt_k or not comp_k:
        raise SystemExit("sft/full-ft needs data.prompt and data.completion")
    rows_in = _load_rows(src)
    loss_all = obj in ("full-ft", "full-finetune", "full-fine-tune")
    rows: list[dict] = []
    for r in rows_in:
        prompt = str(r.get(prompt_k) or "")
        comp = str(r.get(comp_k) or "")
        full = prompt.rstrip() + "\n" + comp.lstrip()
        full_enc = tok(full, truncation=True, max_length=max_len, padding=False, add_special_tokens=True)
        prompt_enc = tok(prompt, truncation=True, max_length=max_len, add_special_tokens=True)
        ids = list(full_enc["input_ids"])
        plen = min(len(prompt_enc["input_ids"]), len(ids))
        labels = list(ids)
        if not loss_all:
            for i in range(plen):
                labels[i] = -100
        pad_id = tok.pad_token_id
        if pad_id is not None:
            labels = [-100 if t == pad_id else t for t in labels]
        rows.append(
            {
                "input_ids": ids,
                "attention_mask": list(full_enc["attention_mask"]),
                "labels": labels,
            }
        )
    if not rows:
        raise SystemExit("empty sft data")
    return _list_dataset(torch, rows)


def _load_parent_weights(model, rec: dict, used_lora: bool):
    """Load prior aq checkpoint into the in-memory model when init.checkpoint is set."""
    init = rec.get("init") if isinstance(rec.get("init"), dict) else {}
    rel = init.get("checkpoint") or opt(rec, "from_ckpt", None)
    if not rel:
        return model
    train = _train_root(rec)
    ckpt_path = (train / str(rel)).resolve()
    if ckpt_path.is_file() and ckpt_path.suffix == ".json":
        meta = json.loads(ckpt_path.read_text(encoding="utf-8"))
        sub = meta.get("adapter_path") or meta.get("model_path")
        if not sub:
            raise SystemExit(f"parent checkpoint {rel} has no adapter_path/model_path")
        weight_dir = (train / str(sub)).resolve()
    elif ckpt_path.is_dir():
        weight_dir = ckpt_path
        meta = {}
    else:
        raise SystemExit(f"init.checkpoint not found: {rel}")
    if not weight_dir.is_dir():
        raise SystemExit(f"parent weights dir missing: {weight_dir}")

    peft = require_peft()
    transformers = require_transformers()
    import torch

    if (weight_dir / "adapter_config.json").is_file():
        if not used_lora:
            raise SystemExit("parent is a LoRA adapter; continue with objective lora/qlora")
        sd = None
        bin_path = weight_dir / "adapter_model.bin"
        safe_path = weight_dir / "adapter_model.safetensors"
        if safe_path.is_file():
            from safetensors.torch import load_file

            sd = load_file(str(safe_path))
        elif bin_path.is_file():
            sd = torch.load(bin_path, map_location="cpu", weights_only=True)
        if not sd:
            raise SystemExit(f"no adapter weights in {weight_dir}")
        from peft import set_peft_model_state_dict

        set_peft_model_state_dict(model, sd)
        return model

    if (weight_dir / "config.json").is_file():
        parent = transformers.AutoModelForCausalLM.from_pretrained(str(weight_dir))
        missing, unexpected = model.load_state_dict(parent.state_dict(), strict=False)
        if missing and len(missing) > len(parent.state_dict()) // 2:
            raise SystemExit(
                f"parent weight load looked wrong (missing {len(missing)} keys). "
                "Check init.checkpoint matches this architecture."
            )
        return model

    raise SystemExit(f"unrecognized parent checkpoint layout: {weight_dir}")


def fit(src: Path, rec: dict, *, method_name: str | None = None) -> dict:
    torch = require_torch()
    transformers = require_transformers()
    deploy_mod._reject_unsupported(rec)
    if deploy_mod.speculative_requested(rec) and not deploy_mod.draft_model_id(rec):
        raise SystemExit(
            "recipe speculative: true needs a draft model.\n"
            "Reason: assisted decode loads a smaller assistant beside the target.\n"
            "Fix: set draft_model: <hub-id> (or speculative: { draft: <hub-id> })."
        )
    obj = _objective(rec, method_name)
    texts, sources = _texts_from_data(src, rec)
    max_len = int(opt(rec, "max_seq_len", opt(rec, "context", 512, "llm"), "train", "llm") or 512)
    texts = _pack_mixture(texts, sources, rec, max_len, None)

    slot = _ckpt_slot(rec)
    model, tok, model_id, want_qlora, used_lora, qlora_engine, tok_meta, mlm_causal = _build_model_and_tok(
        rec, obj, slot, texts
    )
    model = _load_parent_weights(model, rec, used_lora)

    if obj in ("mtp", "multi-token", "multi-token-prediction"):
        if want_qlora or used_lora:
            raise SystemExit("objective mtp does not support QLoRA/LoRA yet")
        from backends.mtp import n_predict_from_rec, wrap_mtp

        model = wrap_mtp(model, n_predict_from_rec(rec))

    steps = opt(rec, "steps", None, "train", "llm")
    epochs = opt(rec, "epochs", None, "train", "llm")
    if steps is None and epochs is None:
        steps = 100
    lr = float(opt(rec, "lr", 2e-4, "train", "llm"))
    batch = int(opt(rec, "batch_size", 1, "train", "llm") or 1)
    accum = int(opt(rec, "grad_accum", 1, "train", "llm") or 1)
    warmup = int(opt(rec, "warmup_steps", 0, "train", "llm") or 0)
    seed = int(opt(rec, "seed", 0, "train", "llm") or 0)
    transformers.set_seed(seed)

    ds = _build_dataset(torch, tok, texts, rec, obj, max_len, src=src)
    load_dtype, prec = resolve_train_precision(rec)
    cuda_alloc_hygiene()
    from backends.device import log_plan, plan_compute

    plan = plan_compute(rec, workload="llm", default_batch=batch, default_max_seq=max_len)
    # recipe-explicit batch/seq already in plan; sync locals
    batch = plan.batch_size
    accum = plan.grad_accum
    log_plan(plan)

    ta_kw: dict[str, Any] = dict(
        output_dir=str(slot / "hf" / "trainer"),
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=accum,
        learning_rate=lr,
        max_steps=int(steps) if steps is not None else -1,
        num_train_epochs=float(epochs) if epochs is not None and steps is None else 1.0,
        warmup_steps=warmup,
        logging_steps=max(1, int(steps or 10) // 10),
        save_strategy="no",
        report_to=[],
        remove_unused_columns=False,
        seed=seed,
        use_cpu=(device_kind() == "cpu"),
        dataloader_pin_memory=(device_kind() in ("cuda", "rocm")),
        # Default from machine plan when recipe omitted gradient_checkpointing
        gradient_checkpointing=plan.gradient_checkpointing
        if opt(rec, "gradient_checkpointing", None, "train", "llm") is None
        else bool(opt(rec, "gradient_checkpointing", False, "train", "llm")),
        **prec,
    )
    # Prefer fused Adam on CUDA when available (fall back if Transformers rejects it).
    if device_kind() == "cuda":
        ta_kw["optim"] = str(opt(rec, "optim", "adamw_torch_fused", "train", "llm") or "adamw_torch_fused")
    try:
        training_args = transformers.TrainingArguments(**ta_kw)
    except (TypeError, ValueError):
        ta_kw.pop("optim", None)
        ta_kw.pop("dataloader_pin_memory", None)
        training_args = transformers.TrainingArguments(**ta_kw)

    from protocol.autolog import hf_trainer_callback

    req_dtype = default_dtype(rec)
    if str(req_dtype) != str(load_dtype):
        print(
            f"  dtype  recipe asked {req_dtype} → using {load_dtype} on this GPU",
            file=__import__("sys").stderr,
        )

    from backends.mtp import mtp_collator

    collator = (
        mtp_collator(tok)
        if obj in ("mtp", "multi-token", "multi-token-prediction")
        else _lm_collator(tok)
    )

    trainer = transformers.Trainer(
        model=model,
        args=training_args,
        train_dataset=ds,
        data_collator=collator,
        callbacks=[hf_trainer_callback()],
    )
    try:
        result = trainer.train()
    except Exception as e:
        msg = str(e)
        if "out of memory" in msg.lower() or "oom" in msg.lower():
            raise SystemExit(
                f"{msg}\n\n"
                "VRAM tips: method/objective lora (or bits: 4 QLoRA), lower max_seq_len, "
                "batch_size: 1, raise grad_accum, dtype: fp16, "
                "gradient_checkpointing: true. "
                f"(load_dtype={load_dtype})"
            ) from e
        raise
    train_loss = float(result.training_loss) if result.training_loss is not None else None

    adapter_rel = None
    model_rel = None
    if used_lora:
        adapter_dir = slot / "adapter"
        model.save_pretrained(str(adapter_dir))
        tok.save_pretrained(str(adapter_dir))
        adapter_rel = str(adapter_dir.relative_to(_train_root(rec)))
    else:
        model_dir = slot / "model"
        if obj in ("mtp", "multi-token", "multi-token-prediction"):
            from backends.mtp import save_mtp

            save_mtp(model_dir, model)
        else:
            model.save_pretrained(str(model_dir))
        tok.save_pretrained(str(model_dir))
        model_rel = str(model_dir.relative_to(_train_root(rec)))

    size = opt(rec, "size", None)
    manifest = {
        "kind": str(rec.get("method") or "llm"),
        "backend": "transformers",
        "task": "lm",
        "objective": "qlora" if want_qlora else obj,
        "mlm_causal": mlm_causal if obj in ("mlm", "masked", "masked-lm") else None,
        "mask_rate": float(opt(rec, "mask_rate", 0.15, "llm") or 0.15)
        if obj in ("mlm", "masked", "masked-lm")
        else None,
        "model_id": model_id,
        "size": size,
        "device": device_kind(),
        "qlora_engine": qlora_engine,
        "train_loss": train_loss,
        "steps": int(steps) if steps is not None else None,
        "lr": lr,
        "rank": int(opt(rec, "rank", 0, "lora", "peft") or 0) or None,
        "alpha": int(opt(rec, "alpha", 0, "lora", "peft") or 0) or None,
        "bits": 4 if want_qlora else None,
        "max_seq_len": max_len,
        "n_docs": len(texts),
        "n_predict": int(opt(rec, "n_predict", 2) or 2)
        if obj in ("mtp", "multi-token", "multi-token-prediction")
        else None,
        "adapter_path": adapter_rel,
        "model_path": model_rel,
        "weights_dir": str(slot.relative_to(_train_root(rec))),
        "mixture": rec.get("mixture"),
    }
    if tok_meta:
        manifest["tokenizer"] = tok_meta
    else:
        manifest["tokenizer"] = {
            "algo": str(opt(rec, "tokenizer", "hf") or "hf"),
            "model_id": model_id,
            "vocab_size": len(tok),
        }

    # Parent / continued-pretrain bookkeeping
    init = rec.get("init") if isinstance(rec.get("init"), dict) else {}
    if init.get("checkpoint") or opt(rec, "from_ckpt", None):
        manifest["parent"] = init.get("checkpoint") or opt(rec, "from_ckpt", None)
        manifest["objective"] = manifest["objective"] if obj not in (
            "continued-pretrain",
            "cpt",
            "continue",
        ) else "continued-pretrain"

    # Deploy knobs (prune / aquant / formats)
    from backends.formats_export import formats_requested

    if (
        opt(rec, "prune", None) is not None
        or opt(rec, "quant", None) is not None
        or formats_requested(rec)
    ):
        deploy_target = model.inner if hasattr(model, "inner") else model
        deploy_mod.apply_deploy(deploy_target, tok, slot, rec, manifest)

    deploy_mod.note_serve_intent(rec, manifest)

    return manifest


def _load_for_infer(train: Path, model: dict):
    torch = require_torch()
    transformers = require_transformers()
    model_id = model.get("model_id")
    if not model_id:
        raise SystemExit("checkpoint missing model_id")
    adapter = model.get("adapter_path")
    full = model.get("model_path")
    qlora = model.get("bits") == 4 or model.get("objective") == "qlora"
    dtype = default_dtype({})
    load_kw: dict[str, Any] = {"trust_remote_code": True}
    apply_pretrained_dtype(load_kw, dtype)
    if qlora and supports_bnb_4bit():
        from transformers import BitsAndBytesConfig

        load_kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True)
        load_kw["device_map"] = "auto"
    elif device_kind() in ("cuda", "rocm"):
        load_kw["device_map"] = "auto"

    model_dir = (train / str(full)) if full else None

    if model_dir is not None and (model_dir / "mtp_meta.json").is_file():
        from backends.mtp import load_mtp

        m = load_mtp(model_dir)
        tok = transformers.AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    elif model.get("objective") in ("mlm", "masked", "masked-lm") and full:
        if model.get("mlm_causal"):
            m = transformers.AutoModelForCausalLM.from_pretrained(str(train / str(full)), **load_kw)
        else:
            m = transformers.AutoModelForMaskedLM.from_pretrained(str(train / str(full)), **load_kw)
        tok = transformers.AutoTokenizer.from_pretrained(str(train / str(full)), trust_remote_code=True)
    elif full:
        m = transformers.AutoModelForCausalLM.from_pretrained(str(train / str(full)), **load_kw)
        tok = transformers.AutoTokenizer.from_pretrained(str(train / str(full)), trust_remote_code=True)
    else:
        m = transformers.AutoModelForCausalLM.from_pretrained(model_id, **load_kw)
        if adapter:
            peft = require_peft()
            m = peft.PeftModel.from_pretrained(m, str(train / str(adapter)))
        tok = transformers.AutoTokenizer.from_pretrained(
            str(train / str(adapter)) if adapter else model_id,
            trust_remote_code=True,
        )
    if device_kind() == "mps" and "device_map" not in load_kw:
        m.to(torch_device())
    ensure_pad_token(tok)
    m.eval()
    return m, tok


def _mtp_eval_loss(m, tok, texts: list[str], n_predict: int, max_len: int) -> list[float]:
    torch = require_torch()
    from backends.mtp import build_mtp_rows, mtp_collator

    rows = build_mtp_rows(tok, texts, max_len, n_predict)
    batch = mtp_collator(tok)(rows)
    batch = move_batch(batch, m)
    with torch.no_grad():
        out = m(**batch)
    return [float(out.loss)] if out.loss is not None else [0.0]


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else src.parent
    for p in [src.parent, *src.parents]:
        if (p / "recipe.yaml").is_file():
            train = p
            break
    m, tok = _load_for_infer(train, model)
    texts, _ = _texts_from_data(src, rec)
    max_len = int(model.get("max_seq_len") or 512)
    if model.get("objective") in ("mtp", "multi-token", "multi-token-prediction"):
        losses = _mtp_eval_loss(
            m, tok, texts, int(model.get("n_predict") or 2), max_len
        )
        if not losses:
            return 0.0, 0
        return sum(losses) / len(losses), len(texts)
    losses = []
    with torch.no_grad():
        for t in texts:
            enc = tok(t, return_tensors="pt", truncation=True, max_length=max_len)
            enc = move_batch(enc, m)
            if model.get("objective") in ("mlm", "masked", "masked-lm"):
                out = m(**enc, labels=enc["input_ids"])
            else:
                out = m(**enc, labels=enc["input_ids"])
            losses.append(float(out.loss))
    if not losses:
        return 0.0, 0
    return sum(losses) / len(losses), len(losses)


def _load_draft(draft_id: str, target):
    """Load a smaller causal LM for Hugging Face assisted / speculative decode."""
    torch = require_torch()
    transformers = require_transformers()
    dtype = default_dtype({})
    load_kw: dict[str, Any] = {"trust_remote_code": True}
    apply_pretrained_dtype(load_kw, dtype)
    if device_kind() in ("cuda", "rocm"):
        load_kw["device_map"] = "auto"
    path = Path(draft_id)
    src = str(path) if path.is_dir() else draft_id
    try:
        assistant = transformers.AutoModelForCausalLM.from_pretrained(src, **load_kw)
    except Exception as e:
        raise SystemExit(
            f"failed to load draft_model {draft_id!r} for speculative decode: {e}"
        ) from e
    if device_kind() == "mps" and "device_map" not in load_kw:
        assistant.to(torch_device())
    # Prefer keeping assistant on the same device as the target when not sharded.
    try:
        tdev = next(target.parameters()).device
        if "device_map" not in load_kw and tdev.type != "meta":
            assistant.to(tdev)
    except StopIteration:
        pass
    assistant.eval()
    return assistant


def generate(
    model: dict,
    prompt: str,
    rec: dict,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict:
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else Path.cwd()
    deploy_mod.warn_serve_intent(rec, model)
    m, tok = _load_for_infer(train, model)
    mt = int(max_tokens if max_tokens is not None else opt(rec, "max_tokens", 64, "serve") or 64)
    temp = float(
        temperature if temperature is not None else opt(rec, "temperature", 0.7, "serve") or 0.7
    )
    enc = move_batch(tok(prompt, return_tensors="pt"), m)
    gen_kw = dict(
        max_new_tokens=mt,
        do_sample=temp > 0,
        pad_token_id=tok.pad_token_id,
        eos_token_id=tok.eos_token_id,
        use_cache=True,
    )
    if temp > 0:
        gen_kw["temperature"] = max(temp, 1e-5)

    assistant = None
    draft = None
    if deploy_mod.speculative_requested(rec) or (model.get("serve_intent") or {}).get("speculative"):
        draft = deploy_mod.draft_model_id(rec, model)
        if not draft:
            raise SystemExit(
                "speculative decode requested but no draft_model in recipe or checkpoint.\n"
                "Fix: set draft_model: <hub-id> (smaller causal LM, same tokenizer family)."
            )
        print(f"  serve  speculative decode with draft={draft}", file=sys.stderr)
        assistant = _load_draft(draft, m)
        gen_kw["assistant_model"] = assistant

    with torch.no_grad():
        try:
            out = m.generate(**enc, **gen_kw)
        except TypeError as e:
            if assistant is not None and "assistant_model" in str(e):
                raise SystemExit(
                    "this transformers build does not support assistant_model. "
                    "Upgrade transformers, or remove speculative: true."
                ) from e
            raise
        except Exception as e:
            if assistant is not None:
                raise SystemExit(
                    f"speculative decode failed ({e}). "
                    "Draft and target usually need the same tokenizer / vocab. "
                    "Pick a smaller sibling (e.g. Llama-3.2-1B draft for a 3B target), "
                    "or remove speculative: true."
                ) from e
            raise
    text = tok.decode(out[0], skip_special_tokens=True)
    result = {
        "completion": text,
        "tokens": int(out.shape[-1]),
        "prompt": prompt,
        "device": device_kind(),
    }
    if draft:
        result["speculative"] = True
        result["draft_model"] = draft
    return result


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"device: {model.get('device')}",
        f"model_id: {model.get('model_id')}",
        f"size: {model.get('size')}",
        f"objective: {model.get('objective')}",
    ]
    if model.get("objective") in ("mlm", "masked", "masked-lm"):
        lines.append(f"causal: {model.get('mlm_causal')}")
        lines.append(f"mask_rate: {model.get('mask_rate')}")
    if model.get("objective") in ("mtp", "multi-token", "multi-token-prediction"):
        lines.append(f"n_predict: {model.get('n_predict')}")
    if model.get("draft_model") or (model.get("serve_intent") or {}).get("speculative"):
        spec = (model.get("serve_intent") or {}).get("speculative") or {}
        lines.append(f"draft_model: {model.get('draft_model') or spec.get('draft_model')}")
    lines.extend(
        [
            f"qlora_engine: {model.get('qlora_engine')}",
            f"train_loss: {model.get('train_loss')}",
            f"adapter_path: {model.get('adapter_path')}",
            f"model_path: {model.get('model_path')}",
            f"tokenizer: {model.get('tokenizer')}",
            f"deploy: {model.get('deploy')}",
            "",
        ]
    )
    rel = "artifacts/inspect.md"
    (train / rel).write_text("\n".join(lines), encoding="utf-8")
    return rel
