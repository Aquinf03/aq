"""Generative VLMs — LLaVA / Flamingo / GPT-4V-style (aq vision connector + HF LM)."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import json
import sys
from pathlib import Path
from typing import Any

from backends.device import (
    apply_pretrained_dtype,
    cuda_alloc_hygiene,
    device_kind,
    is_oom,
    log_plan,
    model_load_dtype,
    plan_compute,
    shrink_plan_for_oom,
    torch_device,
)
from backends.deps import require_torch
from backends.hf_lm import resolve_model_id
from backends.recipe_opt import opt
from backends.tok_train import load_hf_tokenizer
from backends.vlm_data import load_image_tensor, resolve_chat, split_pairs
from neural.vlm.factory import resolve_gen_arch
from neural.vlm.flamingo import FlamingoForCausalLM
from neural.vlm.llava import LLaVAForCausalLM
from protocol import metrics as aq_metrics

IMAGE_TOKEN = "<image>"


def fit(src: Path, rec: dict) -> dict:
    torch = require_torch()
    from torch.utils.data import Dataset
    from transformers import AutoModelForCausalLM, Trainer, TrainingArguments

    train_root = Path(rec["_train"]) if rec.get("_train") else src.parent
    arch_raw = str(opt(rec, "arch", "llava", "train", "vlm", "llava") or "llava")
    arch_key = resolve_gen_arch(arch_raw)
    vision_arch = str(opt(rec, "vision", "vit-b/16", "train", "vlm", "llava") or "vit-b/16")
    vision_pretrained = opt(rec, "vision_pretrained", None, "train", "vlm", "llava")
    if vision_pretrained is None:
        vision_pretrained = opt(rec, "pretrained", None, "train", "vlm", "llava")
    image_size = int(opt(rec, "image_size", 224, "train", "vlm", "llava") or 224)
    model_id = resolve_model_id(rec)
    local = train_root / model_id
    if local.is_dir() and (local / "config.json").is_file():
        model_id = str(local.resolve())
    elif not Path(model_id).is_dir() and "/" not in model_id and not model_id.startswith("."):
        pass
    elif Path(model_id).is_dir():
        model_id = str(Path(model_id).resolve())

    freeze_vision = bool(opt(rec, "freeze_vision", True, "train", "vlm", "llava"))
    freeze_lm = bool(
        opt(rec, "freeze_lm", arch_key == "flamingo", "train", "vlm", "llava")
    )
    lr = float(opt(rec, "lr", 2e-5, "train", "vlm", "llava") or 2e-5)
    epochs = float(opt(rec, "epochs", 1, "train", "vlm", "llava") or 1)
    steps = opt(rec, "steps", None, "train", "vlm", "llava")
    seed = int(opt(rec, "seed", 0, "train", "vlm", "llava") or 0)
    val_frac = float(opt(rec, "val_frac", 0.0, "train", "vlm", "llava") or 0.0)
    cross_every = int(opt(rec, "cross_every", 1, "train", "vlm", "llava") or 1)
    num_latents = int(opt(rec, "num_latents", 64, "train", "vlm", "llava") or 64)
    resampler_depth = int(opt(rec, "resampler_depth", 6, "train", "vlm", "llava") or 6)

    plan = plan_compute(rec, workload="vlm", default_batch=1, default_max_seq=512)
    log_plan(plan)
    max_len = int(plan.max_seq_len or 512)
    batch = plan.batch_size
    dtype = plan.dtype

    rows = resolve_chat(src, rec)
    train_rows, val_rows = split_pairs(rows, val_frac, seed)

    slot = _ckpt_slot(train_root)
    tok, _ = load_hf_tokenizer(model_id, None)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    if IMAGE_TOKEN not in tok.get_vocab():
        tok.add_special_tokens({"additional_special_tokens": [IMAGE_TOKEN]})
    image_token_id = tok.convert_tokens_to_ids(IMAGE_TOKEN)

    cuda_alloc_hygiene()
    load_kw: dict[str, Any] = {"low_cpu_mem_usage": True}
    apply_pretrained_dtype(load_kw, dtype)
    lang = AutoModelForCausalLM.from_pretrained(model_id, **load_kw)
    lang.resize_token_embeddings(len(tok))

    if arch_key == "flamingo":
        model = FlamingoForCausalLM(
            lang,
            vision_arch=vision_arch,
            img_size=image_size,
            num_latents=num_latents,
            resampler_depth=resampler_depth,
            cross_every=cross_every,
            freeze_vision=freeze_vision,
            freeze_lm=freeze_lm,
            vision_pretrained=vision_pretrained,
        )
    else:
        model = LLaVAForCausalLM(
            lang,
            vision_arch=vision_arch,
            img_size=image_size,
            freeze_vision=freeze_vision,
            freeze_lm=freeze_lm,
            vision_pretrained=vision_pretrained,
        )

    device = torch_device()
    if device_kind() != "cpu" and dtype != torch.float32:
        model.to(device=device, dtype=dtype)
    else:
        model.to(device)

    aq_metrics.event(
        "info",
        arch=arch_key,
        vision=vision_arch,
        model=model_id,
        samples=len(rows),
        image_size=image_size,
        freeze_vision=freeze_vision,
        freeze_lm=freeze_lm,
        epochs=epochs,
        **plan.as_event(),
    )

    class ChatDS(Dataset):
        def __init__(self, items):
            self.items = items

        def __len__(self):
            return len(self.items)

        def __getitem__(self, i):
            row = self.items[i]
            img = load_image_tensor(row["image"], image_size, train=True)
            prompt_parts = []
            answer = ""
            for t in row["turns"]:
                if t["role"] == "user":
                    content = t["content"]
                    if IMAGE_TOKEN not in content:
                        content = IMAGE_TOKEN + "\n" + content
                    prompt_parts.append("User: " + content)
                else:
                    answer = t["content"]
            prompt = "\n".join(prompt_parts) + "\nAssistant:"
            full = prompt + " " + answer
            enc_full = tok(full, truncation=True, max_length=max_len, padding=False)
            enc_prompt = tok(prompt, truncation=True, max_length=max_len, padding=False)
            input_ids = enc_full["input_ids"]
            labels = list(input_ids)
            plen = len(enc_prompt["input_ids"])
            for j in range(min(plen, len(labels))):
                labels[j] = -100
            return {
                "input_ids": input_ids,
                "attention_mask": enc_full["attention_mask"],
                "labels": labels,
                "images": img,
                "image_token_id": image_token_id,
            }

    def collate(features: list[dict]) -> dict[str, Any]:
        pad_id = tok.pad_token_id
        max_l = max(len(f["input_ids"]) for f in features)
        input_ids, attention_mask, labels, images = [], [], [], []
        for f in features:
            n = max_l - len(f["input_ids"])
            input_ids.append(f["input_ids"] + [pad_id] * n)
            attention_mask.append(f["attention_mask"] + [0] * n)
            labels.append(f["labels"] + [-100] * n)
            images.append(f["images"])
        imgs = torch.stack(images, 0)
        if device_kind() != "cpu" and dtype != torch.float32:
            imgs = imgs.to(dtype=dtype)
        batch_out = {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_mask, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
            "images": imgs,
        }
        if arch_key != "flamingo":
            batch_out["image_token_id"] = image_token_id
        return batch_out

    train_ds = ChatDS(train_rows)
    max_steps = int(steps) if steps is not None else -1

    def _build_trainer(p):
        ta_kw: dict[str, Any] = dict(
            output_dir=str(slot / "hf" / "trainer"),
            per_device_train_batch_size=p.batch_size,
            gradient_accumulation_steps=p.grad_accum,
            learning_rate=lr,
            num_train_epochs=epochs if max_steps < 0 else 1.0,
            max_steps=max_steps,
            logging_steps=1,
            save_strategy="no",
            report_to=[],
            remove_unused_columns=False,
            dataloader_pin_memory=(device_kind() in ("cuda", "rocm")),
            seed=seed,
            use_cpu=(device_kind() == "cpu"),
            gradient_checkpointing=p.gradient_checkpointing,
            **p.prec_flags,
        )
        try:
            args = TrainingArguments(**ta_kw)
        except (TypeError, ValueError):
            ta_kw.pop("dataloader_pin_memory", None)
            ta_kw.pop("use_cpu", None)
            args = TrainingArguments(**ta_kw)

        class VLMTrainer(Trainer):
            def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
                outputs = model(**inputs)
                loss = outputs.loss
                return (loss, outputs) if return_outputs else loss

        tr = VLMTrainer(
            model=model,
            args=args,
            train_dataset=train_ds,
            data_collator=collate,
        )
        from transformers import TrainerCallback

        class MetricsCB(TrainerCallback):
            def on_log(self, args, state, control, logs=None, **kwargs):
                if logs and "loss" in logs:
                    aq_metrics.step(
                        step=int(state.global_step),
                        loss=logs.get("loss"),
                        lr=logs.get("learning_rate", lr),
                        epoch=state.epoch,
                    )

        tr.add_callback(MetricsCB())
        if p.gradient_checkpointing and hasattr(model, "gradient_checkpointing_enable"):
            model.gradient_checkpointing_enable()
            if hasattr(model, "enable_input_require_grads"):
                model.enable_input_require_grads()
        return tr

    trainer = _build_trainer(plan)
    try:
        trainer.train()
    except Exception as e:
        if not is_oom(e):
            raise
        try:
            from protocol import infra as aq_infra

            aq_infra.emit("oom", str(e)[:500], backend="vlm", phase="first")
        except Exception:
            pass
        print(f"  oom   {e}", file=sys.stderr)
        plan = shrink_plan_for_oom(plan)
        log_plan(plan, prefix="  retry ")
        try:
            from protocol import infra as aq_infra

            aq_infra.emit(
                "retry",
                "VLM OOM auto-shrink",
                backend="vlm",
                batch_size=plan.batch_size,
                max_seq_len=plan.max_seq_len,
            )
        except Exception:
            pass
        cuda_alloc_hygiene()
        batch = plan.batch_size
        max_len = int(plan.max_seq_len or max_len)
        try:
            trainer = _build_trainer(plan)
            trainer.train()
        except Exception as e2:
            if is_oom(e2):
                try:
                    from protocol import infra as aq_infra

                    aq_infra.emit("oom", str(e2)[:500], backend="vlm", phase="retry")
                except Exception:
                    pass
                raise SystemExit(
                    f"{e2}\n\n"
                    "VLM still OOM after aq auto-shrink. Try a smaller `model:`, "
                    "`vision: vit-t/16`, `image_size: 128`, `max_seq_len: 256`, "
                    "or `freeze_lm: true`. "
                    f"Last plan: {plan.as_event()}"
                ) from e2
            raise

    lang_dir = slot / "model"
    lang_dir.mkdir(parents=True, exist_ok=True)
    model.lang_model.save_pretrained(lang_dir)
    tok.save_pretrained(lang_dir)
    connector = {
        "vision": model.vision.state_dict(),
        "arch_key": arch_key,
        "vision_arch": vision_arch,
        "vision_pretrained": vision_pretrained,
        "image_size": image_size,
        "image_token": IMAGE_TOKEN,
        "freeze_vision": freeze_vision,
        "freeze_lm": freeze_lm,
        "dtype": str(dtype).replace("torch.", ""),
    }
    if arch_key == "flamingo":
        connector["vision_proj"] = model.vision_proj.state_dict()
        connector["resampler"] = model.resampler.state_dict()
        connector["gated_xattn"] = model.gated_xattn.state_dict()
        connector["num_latents"] = num_latents
        connector["cross_every"] = cross_every
    else:
        connector["projector"] = model.projector.state_dict()
    torch.save(connector, slot / "vlm_connector.pt")

    last_loss = None
    for row in reversed(trainer.state.log_history or []):
        if row.get("loss") is not None:
            last_loss = float(row["loss"])
            break
        if row.get("train_loss") is not None:
            last_loss = float(row["train_loss"])
            break
    meta = {
        "kind": arch_key,
        "backend": "aq-neural+transformers",
        "task": "multimodal-sft",
        "family": "vlm",
        "arch": arch_raw,
        "arch_key": arch_key,
        "vision_arch": vision_arch,
        "vision_pretrained": vision_pretrained,
        "model_id": model_id,
        "model_path": str(lang_dir.relative_to(train_root)),
        "connector_path": str((slot / "vlm_connector.pt").relative_to(train_root)),
        "image_size": image_size,
        "image_token": IMAGE_TOKEN,
        "n_samples": len(rows),
        "n_train": len(train_rows),
        "n_val": len(val_rows),
        "steps": int(trainer.state.global_step),
        "train_loss": last_loss,
        "lr": lr,
        "dtype": str(dtype).replace("torch.", ""),
        "batch_size": batch,
        "grad_accum": plan.grad_accum,
        "gradient_checkpointing": plan.gradient_checkpointing,
        "device": device_kind(),
        "gpu": plan.machine.name,
        "vram_gb": plan.machine.total_gb,
        "weights_dir": str(slot.relative_to(train_root)),
        "freeze_vision": freeze_vision,
        "freeze_lm": freeze_lm,
        "params": sum(p.numel() for p in model.parameters()),
    }
    (slot / "vlm_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def _ckpt_slot(train: Path) -> Path:
    dest = ckpt_dir(train)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name not in ("last.json",) and p.is_file())
    n = max(n, 1 + sum(1 for p in dest.iterdir() if p.is_dir() and p.name.isdigit()))
    slot = dest / str(n)
    slot.mkdir(parents=True, exist_ok=True)
    return slot


def _load(train: Path, model: dict):
    torch = require_torch()
    from transformers import AutoModelForCausalLM, AutoTokenizer

    lang_rel = model.get("model_path")
    conn_rel = model.get("connector_path")
    if not lang_rel or not conn_rel:
        raise SystemExit("checkpoint missing model_path / connector_path")
    tok = AutoTokenizer.from_pretrained(train / str(lang_rel))
    dtype = model_load_dtype({})
    load_kw: dict[str, Any] = {"low_cpu_mem_usage": True}
    apply_pretrained_dtype(load_kw, dtype)
    lang = AutoModelForCausalLM.from_pretrained(train / str(lang_rel), **load_kw)
    blob = torch.load(train / str(conn_rel), map_location="cpu", weights_only=False)
    arch_key = blob.get("arch_key") or model.get("arch_key") or "llava"
    vision_arch = blob.get("vision_arch") or "vit-b/16"
    vision_pretrained = blob.get("vision_pretrained") or model.get("vision_pretrained")
    image_size = int(blob.get("image_size") or 224)
    if arch_key == "flamingo":
        net = FlamingoForCausalLM(
            lang,
            vision_arch=vision_arch,
            img_size=image_size,
            num_latents=int(blob.get("num_latents") or 64),
            cross_every=int(blob.get("cross_every") or 1),
            freeze_vision=True,
            freeze_lm=True,
            vision_pretrained=vision_pretrained,
        )
        net.vision.load_state_dict(blob["vision"])
        net.vision_proj.load_state_dict(blob["vision_proj"])
        net.resampler.load_state_dict(blob["resampler"])
        net.gated_xattn.load_state_dict(blob["gated_xattn"])
    else:
        net = LLaVAForCausalLM(
            lang,
            vision_arch=vision_arch,
            img_size=image_size,
            freeze_vision=True,
            freeze_lm=True,
            vision_pretrained=vision_pretrained,
        )
        net.vision.load_state_dict(blob["vision"])
        net.projector.load_state_dict(blob["projector"])
    device = torch_device()
    if device_kind() != "cpu" and dtype != torch.float32:
        net.to(device=device, dtype=dtype)
    else:
        net.to(device)
    net.eval()
    image_token_id = tok.convert_tokens_to_ids(blob.get("image_token") or IMAGE_TOKEN)
    return net, tok, image_size, arch_key, image_token_id, dtype


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else src.parent
    net, tok, image_size, arch_key, image_token_id, dtype = _load(train, model)
    rows = resolve_chat(src, rec)
    device = torch_device()
    total_loss = 0.0
    n = 0
    max_len = int(opt(rec, "max_seq_len", 512, "train", "vlm", "llava") or 512)
    for row in rows:
        img = load_image_tensor(row["image"], image_size, train=False).unsqueeze(0).to(device)
        if device_kind() != "cpu" and dtype != torch.float32:
            img = img.to(dtype=dtype)
        prompt_parts = []
        answer = ""
        for t in row["turns"]:
            if t["role"] == "user":
                content = t["content"]
                if IMAGE_TOKEN not in content:
                    content = IMAGE_TOKEN + "\n" + content
                prompt_parts.append("User: " + content)
            else:
                answer = t["content"]
        prompt = "\n".join(prompt_parts) + "\nAssistant:"
        full = prompt + " " + answer
        enc_full = tok(full, truncation=True, max_length=max_len, return_tensors="pt")
        enc_prompt = tok(prompt, truncation=True, max_length=max_len, return_tensors="pt")
        labels = enc_full["input_ids"].clone()
        labels[:, : enc_prompt["input_ids"].shape[1]] = -100
        kwargs = {
            "input_ids": enc_full["input_ids"].to(device),
            "attention_mask": enc_full["attention_mask"].to(device),
            "labels": labels.to(device),
            "images": img,
        }
        if arch_key != "flamingo":
            kwargs["image_token_id"] = image_token_id
        with torch.no_grad():
            out = net(**kwargs)
        total_loss += float(out.loss.item())
        n += 1
    metric = str((rec.get("eval") or {}).get("metric") or "loss").lower()
    avg = total_loss / max(1, n)
    if metric in ("loss", "nll", "ce"):
        return avg, n
    raise SystemExit(f"vlm generative eval metric must be loss, got {metric!r}")


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"family: {model.get('family')}",
        f"arch: {model.get('arch')} ({model.get('arch_key')})",
        f"vision: {model.get('vision_arch')}",
        f"lm: {model.get('model_id')}",
        f"task: {model.get('task')}",
        f"samples: {model.get('n_samples')}",
        f"train_loss: {model.get('train_loss')}",
        f"steps: {model.get('steps')}",
        f"device: {model.get('device')}",
        f"gpu: {model.get('gpu')}",
        f"vram_gb: {model.get('vram_gb')}",
        f"dtype: {model.get('dtype')}",
        f"model: {model.get('model_path')}",
        f"connector: {model.get('connector_path')}",
        "",
    ]
    rel = "artifacts/inspect.md"
    (train / rel).write_text("\n".join(lines), encoding="utf-8")
    return rel


def generate(
    model: dict,
    prompt: str,
    rec: dict,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict:
    """Multimodal generate for LLaVA / Flamingo / GPT-4V-style."""
    torch = require_torch()
    from torch.nn import functional as F

    train = Path(rec["_train"]) if rec.get("_train") else Path.cwd()
    from backends.serve_io import resolve_image, result_text, serve_block
    from backends.vlm_data import load_image_tensor

    img_path, text = resolve_image(prompt, rec, image=rec.get("_serve_image"))
    if img_path is None:
        raise SystemExit(
            "vlm serve needs an image: aq serve \"your question\" --image path.png "
            "(or recipe serve.image / serve.prompt)"
        )
    if not text.strip():
        text = str(serve_block(rec).get("prompt") or "Describe the image.")

    net, tok, image_size, arch_key, image_token_id, dtype = _load(train, model)
    device = torch_device()
    img = load_image_tensor(img_path, image_size, train=False).unsqueeze(0).to(device)
    if device_kind() != "cpu" and dtype != torch.float32:
        img = img.to(dtype=dtype)

    content = text
    if IMAGE_TOKEN not in content:
        content = IMAGE_TOKEN + "\n" + content
    prompt_str = f"User: {content}\nAssistant:"
    enc = tok(prompt_str, return_tensors="pt")
    input_ids = enc["input_ids"].to(device)
    attention_mask = enc.get("attention_mask")
    if attention_mask is not None:
        attention_mask = attention_mask.to(device)

    mt = int(max_tokens if max_tokens is not None else opt(rec, "max_tokens", 64, "serve") or 64)
    temp = float(
        temperature if temperature is not None else opt(rec, "temperature", 0.7, "serve") or 0.7
    )
    eos = tok.eos_token_id
    pad = tok.pad_token_id if tok.pad_token_id is not None else eos

    # Prefer HF generate on LLaVA via expanded embeds; Flamingo uses AR loop.
    completion_ids: list[int] = []
    with torch.no_grad():
        if arch_key != "flamingo" and hasattr(net, "prepare_inputs_embeds"):
            embeds, mask = net.prepare_inputs_embeds(
                input_ids, img, image_token_id, attention_mask
            )
            gen_kw = dict(
                inputs_embeds=embeds,
                attention_mask=mask,
                max_new_tokens=mt,
                do_sample=temp > 0,
                pad_token_id=pad,
                eos_token_id=eos,
                use_cache=True,
            )
            if temp > 0:
                gen_kw["temperature"] = max(temp, 1e-5)
            out_ids = net.lang_model.generate(**gen_kw)
            # generate returns only new tokens when inputs_embeds used? usually full sequence of new
            # HF returns prompt_len + new when input_ids; with inputs_embeds returns generated continuation length varies
            new = out_ids[0]
            # decode all generated token ids (embeds path often returns only new tokens)
            text_out = tok.decode(new, skip_special_tokens=True)
            # strip prompt echo if present
            if text_out.startswith(prompt_str):
                text_out = text_out[len(prompt_str) :].lstrip()
            elif "Assistant:" in text_out:
                text_out = text_out.split("Assistant:")[-1].lstrip()
            return result_text(
                completion=text_out.strip(),
                tokens=int(new.numel()),
                prompt=text,
                image=str(img_path),
                device=device_kind(),
                arch=arch_key,
            )

        cur_ids = input_ids
        cur_mask = attention_mask
        for _ in range(mt):
            kwargs = {
                "input_ids": cur_ids,
                "attention_mask": cur_mask,
                "images": img,
            }
            if arch_key != "flamingo":
                kwargs["image_token_id"] = image_token_id
            out = net(**kwargs)
            logits = out.logits[:, -1, :]
            if temp <= 0:
                next_id = int(logits.argmax(-1).item())
            else:
                probs = F.softmax(logits / max(temp, 1e-5), dim=-1)
                next_id = int(torch.multinomial(probs, 1).item())
            completion_ids.append(next_id)
            if eos is not None and next_id == eos:
                break
            next_t = torch.tensor([[next_id]], device=device, dtype=cur_ids.dtype)
            cur_ids = torch.cat([cur_ids, next_t], dim=1)
            if cur_mask is not None:
                cur_mask = torch.cat(
                    [cur_mask, torch.ones((1, 1), device=device, dtype=cur_mask.dtype)], dim=1
                )

    text_out = tok.decode(completion_ids, skip_special_tokens=True)
    return result_text(
        completion=text_out.strip(),
        tokens=len(completion_ids),
        prompt=text,
        image=str(img_path),
        device=device_kind(),
        arch=arch_key,
    )
