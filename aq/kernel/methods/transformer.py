"""Transformers via Hugging Face. Devices: CUDA / ROCm / MPS / CPU."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import csv
import json
from pathlib import Path

from backends.device import (
    apply_pretrained_dtype,
    cuda_alloc_hygiene,
    device_kind,
    model_load_dtype,
    resolve_train_precision,
    torch_device,
)
from backends.deps import require_torch, require_transformers
from backends.hf_lm import resolve_model_id
from backends.recipe_opt import opt
from backends.tok_train import ensure_pad_token
from protocol.autolog import hf_trainer_callback


def _rows(path: Path) -> list[dict]:
    if path.suffix == ".jsonl":
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fit(src: Path, rec: dict) -> dict:
    torch = require_torch()
    transformers = require_transformers()
    arch = str(opt(rec, "arch", "decoder", "transformer")).lower().replace("_", "-")
    model_id = resolve_model_id(rec, arch=arch)
    steps = int(opt(rec, "steps", 50, "train", "transformer") or 50)
    lr = float(opt(rec, "lr", 5e-5, "train", "transformer") or 5e-5)
    max_len = int(
        opt(rec, "max_seq_len", opt(rec, "seq", 128, "transformer"), "train", "transformer") or 128
    )
    seed = int(opt(rec, "seed", 0) or 0)
    transformers.set_seed(seed)
    data = rec.get("data") or {}
    rows = _rows(src)
    if not rows:
        raise SystemExit("empty data")

    train = Path(rec["_train"])
    dest = ckpt_dir(train)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name != "last.json")
    slot = dest / str(n)
    slot.mkdir(parents=True, exist_ok=True)
    dtype = model_load_dtype(rec)
    _, prec = resolve_train_precision(rec)
    cuda_alloc_hygiene()

    if arch in ("decoder", "causal", "gpt"):
        from backends import hf_lm

        rec2 = {
            **rec,
            "model": model_id,
            "objective": "next-token",
            "steps": steps,
            "lr": lr,
            "max_seq_len": max_len,
        }
        if not (data.get("text") or data.get("target")) and data.get("src"):
            rec2 = {**rec2, "data": {**data, "text": data["src"]}}
        out = hf_lm.fit(src, rec2, method_name="transformer")
        out["arch"] = "decoder"
        out["kind"] = "transformer"
        return out

    if arch in ("encoder", "bert", "classify"):
        text_k = str(data.get("text") or "text")
        target_k = str(data.get("target") or "target")
        texts = [str(r[text_k]) for r in rows]
        labels = [r[target_k] for r in rows]
        classes = sorted({str(x) for x in labels})
        label2id = {c: i for i, c in enumerate(classes)}
        y = [label2id[str(x)] for x in labels]
        tok = transformers.AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        resize = ensure_pad_token(tok)
        load_kw: dict = {"num_labels": len(classes), "trust_remote_code": True}
        apply_pretrained_dtype(load_kw, model_load_dtype(rec))
        model = transformers.AutoModelForSequenceClassification.from_pretrained(
            model_id, **load_kw
        )
        if resize:
            model.resize_token_embeddings(len(tok))
        if device_kind() == "mps":
            model.to(torch_device())
        enc = tok(texts, truncation=True, padding=True, max_length=max_len, return_tensors="pt")

        class DS(torch.utils.data.Dataset):
            def __len__(self):
                return len(y)

            def __getitem__(self, i):
                return {
                    "input_ids": enc["input_ids"][i],
                    "attention_mask": enc["attention_mask"][i],
                    "labels": torch.tensor(y[i]),
                }

        args = transformers.TrainingArguments(
            output_dir=str(slot / "trainer"),
            per_device_train_batch_size=int(opt(rec, "batch_size", 8, "train") or 8),
            learning_rate=lr,
            max_steps=steps,
            logging_steps=max(1, steps // 10),
            save_strategy="no",
            report_to=[],
            seed=seed,
            use_cpu=(device_kind() == "cpu"),
            **prec,
        )

        trainer = transformers.Trainer(
            model=model, args=args, train_dataset=DS(), callbacks=[hf_trainer_callback()]
        )
        result = trainer.train()
        model_dir = slot / "model"
        model.save_pretrained(str(model_dir))
        tok.save_pretrained(str(model_dir))
        return {
            "kind": "transformer",
            "backend": "transformers",
            "arch": "encoder",
            "device": device_kind(),
            "model_id": model_id,
            "classes": classes,
            "train_loss": float(result.training_loss) if result.training_loss is not None else None,
            "model_path": str(model_dir.relative_to(train)),
            "weights_dir": str(slot.relative_to(train)),
            "steps": steps,
            "lr": lr,
        }

    if arch in ("encoder-decoder", "enc-dec", "seq2seq", "t5"):
        src_k = str(data.get("src") or "src")
        tgt_k = str(data.get("tgt") or "tgt")
        sources = [str(r[src_k]) for r in rows]
        targets = [str(r[tgt_k]) for r in rows]
        tok = transformers.AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        resize = ensure_pad_token(tok)
        load_kw: dict = {"trust_remote_code": True}
        apply_pretrained_dtype(load_kw, model_load_dtype(rec))
        model = transformers.AutoModelForSeq2SeqLM.from_pretrained(model_id, **load_kw)
        if resize:
            model.resize_token_embeddings(len(tok))
        if device_kind() == "mps":
            model.to(torch_device())
        enc = tok(sources, truncation=True, padding=True, max_length=max_len, return_tensors="pt")
        lab = tok(text_target=targets, truncation=True, padding=True, max_length=max_len, return_tensors="pt")
        labels = lab["input_ids"]
        labels[labels == tok.pad_token_id] = -100

        class DS(torch.utils.data.Dataset):
            def __len__(self):
                return labels.shape[0]

            def __getitem__(self, i):
                return {
                    "input_ids": enc["input_ids"][i],
                    "attention_mask": enc["attention_mask"][i],
                    "labels": labels[i],
                }

        args = transformers.TrainingArguments(
            output_dir=str(slot / "trainer"),
            per_device_train_batch_size=int(opt(rec, "batch_size", 4, "train") or 4),
            learning_rate=lr,
            max_steps=steps,
            logging_steps=max(1, steps // 10),
            save_strategy="no",
            report_to=[],
            seed=seed,
            use_cpu=(device_kind() == "cpu"),
            **prec,
        )

        trainer = transformers.Trainer(
            model=model, args=args, train_dataset=DS(), callbacks=[hf_trainer_callback()]
        )
        result = trainer.train()
        model_dir = slot / "model"
        model.save_pretrained(str(model_dir))
        tok.save_pretrained(str(model_dir))
        return {
            "kind": "transformer",
            "backend": "transformers",
            "arch": "encoder-decoder",
            "device": device_kind(),
            "model_id": model_id,
            "train_loss": float(result.training_loss) if result.training_loss is not None else None,
            "model_path": str(model_dir.relative_to(train)),
            "weights_dir": str(slot.relative_to(train)),
            "steps": steps,
            "lr": lr,
        }

    raise SystemExit(f"unknown transformer arch: {arch}")


def evaluate(model: dict, src: Path, rec: dict):
    if model.get("arch") in (None, "decoder", "causal", "gpt"):
        from backends import hf_lm

        return hf_lm.evaluate(model, src, rec)
    torch = require_torch()
    transformers = require_transformers()
    train = Path(rec["_train"])
    path = train / str(model["model_path"])
    tok = transformers.AutoTokenizer.from_pretrained(str(path), trust_remote_code=True)
    ensure_pad_token(tok)
    if model.get("arch") == "encoder":
        m = transformers.AutoModelForSequenceClassification.from_pretrained(str(path))
        m.eval()
        if device_kind() == "mps":
            m.to(torch_device())
        data = rec.get("data") or {}
        text_k = str(data.get("text") or "text")
        target_k = str(data.get("target") or "target")
        rows = _rows(src)
        classes = model.get("classes") or []
        label2id = {c: i for i, c in enumerate(classes)}
        ok = 0
        with torch.no_grad():
            for r in rows:
                enc = tok(str(r[text_k]), return_tensors="pt", truncation=True)
                enc = {k: v.to(next(m.parameters()).device) for k, v in enc.items()}
                pred = int(m(**enc).logits.argmax(-1).item())
                gold = label2id.get(str(r[target_k]))
                if gold is not None and pred == gold:
                    ok += 1
        n = len(rows)
        return (ok / n if n else 0.0), n
    # seq2seq: mean loss
    from backends import hf_lm

    return hf_lm.evaluate({**model, "objective": "next-token"}, src, rec)


def generate(model, prompt, rec, max_tokens=None, temperature=None):
    from backends import hf_lm

    return hf_lm.generate(model, prompt, rec, max_tokens=max_tokens, temperature=temperature)


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"device: {model.get('device')}",
        f"arch: {model.get('arch')}",
        f"model_id: {model.get('model_id')}",
        f"train_loss: {model.get('train_loss')}",
        "",
    ]
    rel = "artifacts/inspect.md"
    (train / rel).write_text("\n".join(lines), encoding="utf-8")
    return rel
