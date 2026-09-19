"""Train / eval / inspect for family: vlm, method: clip (CLIP / SigLIP)."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import json
from pathlib import Path
from typing import Any

from backends.device import device_kind, torch_device
from backends.deps import require_torch
from backends.recipe_opt import opt
from backends.vlm_data import make_pair_loader, resolve_pairs, split_pairs
from backends.vlm_tokenizer import (
    build_tokenizer_from_texts,
    load_hf_clip_tokenizer,
    SimpleClipTokenizer,
)
from neural.vlm.clip import clip_contrastive_loss, siglip_loss
from neural.vlm.factory import build_clip, resolve_clip_arch
from protocol import metrics as aq_metrics


def fit(src: Path, rec: dict) -> dict:
    torch = require_torch()
    train_root = Path(rec["_train"]) if rec.get("_train") else src.parent

    arch_raw = str(opt(rec, "arch", "clip", "train", "vlm", "clip") or "clip")
    arch_key = resolve_clip_arch(arch_raw)
    vision_arch = str(opt(rec, "vision", "vit-b/16", "train", "vlm", "clip") or "vit-b/16")
    vision_pretrained = opt(rec, "vision_pretrained", None, "train", "vlm", "clip")
    if vision_pretrained is None:
        vision_pretrained = opt(rec, "pretrained", None, "train", "vlm", "clip")
    image_size = int(opt(rec, "image_size", 224, "train", "vlm", "clip") or 224)
    embed_dim = int(opt(rec, "embed_dim", 512, "train", "vlm", "clip") or 512)
    text_width = int(opt(rec, "text_width", 512, "train", "vlm", "clip") or 512)
    text_layers = int(opt(rec, "text_layers", 12, "train", "vlm", "clip") or 12)
    text_heads = int(opt(rec, "text_heads", 8, "train", "vlm", "clip") or 8)
    context_length = int(opt(rec, "context_length", 77, "train", "vlm", "clip") or 77)
    batch = int(opt(rec, "batch_size", 32, "train", "vlm", "clip") or 32)
    lr = float(opt(rec, "lr", 5e-4, "train", "vlm", "clip") or 5e-4)
    weight_decay = float(opt(rec, "weight_decay", 0.2, "train", "vlm", "clip") or 0.2)
    seed = int(opt(rec, "seed", 0, "train", "vlm", "clip") or 0)
    val_frac = float(opt(rec, "val_frac", 0.1, "train", "vlm", "clip") or 0.0)
    epochs = opt(rec, "epochs", None, "train", "vlm", "clip")
    steps = opt(rec, "steps", None, "train", "vlm", "clip")
    if epochs is None and steps is None:
        epochs = 10
    workers = int(opt(rec, "num_workers", 0, "train", "vlm", "clip") or 0)
    max_vocab = int(opt(rec, "max_vocab", 49408, "train", "vlm", "clip") or 49408)
    hf_tok_name = opt(rec, "text_tokenizer", None, "train", "vlm", "clip")

    pairs = resolve_pairs(src, rec)
    torch.manual_seed(seed)
    train_p, val_p = split_pairs(pairs, val_frac, seed)

    if hf_tok_name:
        tokenizer = load_hf_clip_tokenizer(str(hf_tok_name), context_length=context_length)
        vocab_size = tokenizer.vocab_size
    else:
        tokenizer = build_tokenizer_from_texts(
            [t for _, t in train_p],
            context_length=context_length,
            max_vocab=max_vocab,
        )
        vocab_size = tokenizer.vocab_size

    # scale text tower for small vocabs / tiny recipes
    if text_width % text_heads != 0:
        raise SystemExit("text_width must be divisible by text_heads")

    model = build_clip(
        arch_raw,
        vision_arch=vision_arch,
        img_size=image_size,
        embed_dim=embed_dim,
        vocab_size=vocab_size,
        text_width=text_width,
        text_heads=text_heads,
        text_layers=text_layers,
        context_length=context_length,
        vision_pretrained=vision_pretrained,
    )
    from backends.device import log_plan, plan_compute

    plan = plan_compute(rec, workload="clip", default_batch=batch)
    log_plan(plan)
    batch = plan.batch_size
    device = torch_device()
    dtype = plan.dtype
    if device_kind() != "cpu" and dtype != torch.float32:
        model.to(device=device, dtype=dtype)
    else:
        model.to(device)

    train_loader = make_pair_loader(
        train_p, tokenizer, image_size=image_size, batch_size=batch, shuffle=True, train=True, num_workers=workers
    )
    val_loader = (
        make_pair_loader(
            val_p, tokenizer, image_size=image_size, batch_size=batch, shuffle=False, train=False, num_workers=workers
        )
        if val_p
        else None
    )

    aq_metrics.event(
        "info",
        arch=arch_key,
        vision=vision_arch,
        pairs=len(pairs),
        vocab_size=vocab_size,
        embed_dim=embed_dim,
        image_size=image_size,
        device=device_kind(),
        dtype=str(dtype).replace("torch.", ""),
        batch_size=batch,
        gpu=plan.machine.name,
        vram_gb=plan.machine.total_gb,
        epochs=int(epochs) if epochs is not None else None,
    )

    optim = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay, betas=(0.9, 0.98))
    max_steps = int(steps) if steps is not None else None
    n_epochs = int(epochs) if epochs is not None else 10**9
    global_step = 0
    last_loss = None
    best_val = None

    model.train()
    for epoch in range(n_epochs):
        running = 0.0
        n_batches = 0
        for images, text in train_loader:
            images = images.to(device)
            if device_kind() != "cpu" and dtype != torch.float32:
                images = images.to(dtype=dtype)
            text = text.to(device)
            optim.zero_grad(set_to_none=True)
            out = model(images, text)
            if arch_key == "siglip":
                loss = siglip_loss(
                    out["image_features"],
                    out["text_features"],
                    out["logit_scale"],
                    model.logit_bias,
                )
            else:
                loss = clip_contrastive_loss(out["logits_per_image"], out["logits_per_text"])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            running += float(loss.item())
            n_batches += 1
            global_step += 1
            last_loss = float(loss.item())
            # batch retrieval accuracy (diag)
            with torch.no_grad():
                pred = out["logits_per_image"].argmax(-1)
                acc = float((pred == torch.arange(pred.shape[0], device=device)).float().mean())
            aq_metrics.step(step=global_step, loss=last_loss, lr=lr, epoch=epoch, acc=acc)
            if max_steps is not None and global_step >= max_steps:
                break
        payload: dict[str, Any] = {"epoch": epoch + 1, "loss": running / max(1, n_batches)}
        if val_loader is not None:
            v_loss, v_r1 = _eval_retrieval(model, val_loader, device, arch_key)
            payload["val_loss"] = v_loss
            payload["val_acc"] = v_r1
            best_val = v_r1 if best_val is None else max(best_val, v_r1)
            model.train()
        aq_metrics.event("epoch", **payload)
        if max_steps is not None and global_step >= max_steps:
            break

    model.eval()
    _, train_r1 = _eval_retrieval(model, train_loader, device, arch_key)
    slot = _ckpt_slot(train_root)
    weights = slot / "model.pt"
    tok_path = slot / "tokenizer.json"
    if isinstance(tokenizer, SimpleClipTokenizer):
        tokenizer.save(tok_path)
        tok_meta = {"kind": "simple", "path": str(tok_path.relative_to(train_root))}
    else:
        hf_dir = slot / "tokenizer_hf"
        tokenizer.save(hf_dir)
        tok_meta = {"kind": "hf", "name": str(hf_tok_name), "path": str(hf_dir.relative_to(train_root))}

    torch.save(
        {
            "state_dict": model.state_dict(),
            "arch": arch_raw,
            "arch_key": arch_key,
            "vision_arch": vision_arch,
            "vision_pretrained": vision_pretrained,
            "image_size": image_size,
            "embed_dim": embed_dim,
            "vocab_size": vocab_size,
            "text_width": text_width,
            "text_heads": text_heads,
            "text_layers": text_layers,
            "context_length": context_length,
        },
        weights,
    )
    meta = {
        "kind": "clip",
        "backend": "aq-neural",
        "task": "image-text-contrastive",
        "family": "vlm",
        "arch": arch_raw,
        "arch_key": arch_key,
        "vision_arch": vision_arch,
        "vision_pretrained": vision_pretrained,
        "image_size": image_size,
        "embed_dim": embed_dim,
        "vocab_size": vocab_size,
        "n_pairs": len(pairs),
        "n_train": len(train_p),
        "n_val": len(val_p),
        "train_loss": last_loss,
        "train_recall@1": train_r1,
        "val_recall@1": best_val,
        "steps": global_step,
        "lr": lr,
        "device": device_kind(),
        "params": sum(p.numel() for p in model.parameters()),
        "weights_path": str(weights.relative_to(train_root)),
        "weights_dir": str(slot.relative_to(train_root)),
        "tokenizer": tok_meta,
    }
    (slot / "clip_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def _ckpt_slot(train: Path) -> Path:
    dest = ckpt_dir(train)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name not in ("last.json",) and p.is_file())
    n = max(n, 1 + sum(1 for p in dest.iterdir() if p.is_dir() and p.name.isdigit()))
    slot = dest / str(n)
    slot.mkdir(parents=True, exist_ok=True)
    return slot


def _eval_retrieval(model, loader, device, arch_key: str) -> tuple[float, float]:
    torch = require_torch()
    model.eval()
    all_img = []
    all_txt = []
    losses = []
    with torch.no_grad():
        for images, text in loader:
            images = images.to(device)
            text = text.to(device)
            out = model(images, text)
            if arch_key == "siglip":
                loss = siglip_loss(
                    out["image_features"], out["text_features"], out["logit_scale"], model.logit_bias
                )
            else:
                loss = clip_contrastive_loss(out["logits_per_image"], out["logits_per_text"])
            losses.append(float(loss.item()))
            all_img.append(out["image_features"])
            all_txt.append(out["text_features"])
        img = torch.cat(all_img, 0)
        txt = torch.cat(all_txt, 0)
        sim = img @ txt.t()
        pred = sim.argmax(-1)
        r1 = float((pred == torch.arange(pred.shape[0], device=device)).float().mean())
    return sum(losses) / max(1, len(losses)), r1


def _load(train: Path, model: dict):
    torch = require_torch()
    rel = model.get("weights_path")
    path = train / str(rel)
    blob = torch.load(path, map_location="cpu", weights_only=False)
    tok_meta = model.get("tokenizer") or {}
    if tok_meta.get("kind") == "hf":
        from backends.vlm_tokenizer import load_hf_clip_tokenizer

        tokenizer = load_hf_clip_tokenizer(
            str(tok_meta.get("name") or "openai/clip-vit-base-patch32"),
            context_length=int(blob.get("context_length") or 77),
        )
    else:
        tokenizer = SimpleClipTokenizer.load(train / str(tok_meta["path"]))
    net = build_clip(
        blob.get("arch") or model.get("arch") or "clip",
        vision_arch=blob.get("vision_arch") or "vit-b/16",
        img_size=int(blob.get("image_size") or 224),
        embed_dim=int(blob.get("embed_dim") or 512),
        vocab_size=int(blob.get("vocab_size") or tokenizer.vocab_size),
        text_width=int(blob.get("text_width") or 512),
        text_heads=int(blob.get("text_heads") or 8),
        text_layers=int(blob.get("text_layers") or 12),
        context_length=int(blob.get("context_length") or 77),
        vision_pretrained=blob.get("vision_pretrained") or model.get("vision_pretrained"),
    )
    net.load_state_dict(blob["state_dict"])
    net.to(torch_device())
    net.eval()
    return net, tokenizer, int(blob.get("image_size") or 224), str(blob.get("arch_key") or "clip")


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    train = Path(rec["_train"]) if rec.get("_train") else src.parent
    net, tokenizer, image_size, arch_key = _load(train, model)
    pairs = resolve_pairs(src, rec)
    batch = int(opt(rec, "batch_size", 32, "train", "vlm", "clip") or 32)
    loader = make_pair_loader(
        pairs, tokenizer, image_size=image_size, batch_size=batch, shuffle=False, train=False
    )
    loss, r1 = _eval_retrieval(net, loader, torch_device(), arch_key)
    metric = str((rec.get("eval") or {}).get("metric") or "recall@1").lower()
    if metric in ("loss", "nll"):
        return loss, len(pairs)
    if metric in ("recall@1", "r@1", "retrieval", "accuracy", "acc"):
        return r1, len(pairs)
    raise SystemExit(f"clip eval metric must be recall@1 or loss, got {metric!r}")


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"family: {model.get('family')}",
        f"arch: {model.get('arch')} ({model.get('arch_key')})",
        f"vision: {model.get('vision_arch')}",
        f"task: {model.get('task')}",
        f"embed_dim: {model.get('embed_dim')}",
        f"vocab_size: {model.get('vocab_size')}",
        f"pairs: {model.get('n_pairs')}",
        f"params: {model.get('params')}",
        f"train_loss: {model.get('train_loss')}",
        f"train_recall@1: {model.get('train_recall@1')}",
        f"val_recall@1: {model.get('val_recall@1')}",
        f"steps: {model.get('steps')}",
        f"device: {model.get('device')}",
        f"weights: {model.get('weights_path')}",
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
    """CLIP/SigLIP serve: image↔text score, or embed image/text alone."""
    del max_tokens, temperature  # unused for contrastive
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else Path.cwd()
    from backends.serve_io import resolve_image, result_text, serve_block
    from backends.vlm_data import load_image_tensor

    img_path, text = resolve_image(prompt, rec, image=rec.get("_serve_image"))
    net, tokenizer, image_size, arch_key = _load(train, model)
    device = torch_device()
    block = serve_block(rec)

    with torch.no_grad():
        if img_path is not None and text.strip():
            img = load_image_tensor(img_path, image_size, train=False).unsqueeze(0).to(device)
            ids = torch.tensor([tokenizer.encode(text)], dtype=torch.long, device=device)
            out = net(img, ids)
            # diagonal / single-pair similarity
            score = float((out["image_features"] * out["text_features"]).sum(-1).item())
            scale = float(out["logit_scale"].item()) if "logit_scale" in out else 1.0
            return result_text(
                text=f"similarity={score:.4f} (logit_scale={scale:.3f})",
                score=score,
                logit_scale=scale,
                prompt=text,
                image=str(img_path),
                device=device_kind(),
                arch=arch_key,
            )
        if img_path is not None:
            img = load_image_tensor(img_path, image_size, train=False).unsqueeze(0).to(device)
            feats = net.encode_image(img)[0]
            # optional zero-shot labels from serve.labels
            labels = block.get("labels") or block.get("classes")
            if labels:
                labs = [str(x) for x in labels]
                txt = torch.tensor(
                    [tokenizer.encode(t) for t in labs], dtype=torch.long, device=device
                )
                tfeat = net.encode_text(txt)
                sims = (feats.unsqueeze(0) @ tfeat.t()).squeeze(0)
                idx = int(sims.argmax().item())
                return result_text(
                    text=labs[idx],
                    label=labs[idx],
                    score=float(sims[idx].item()),
                    scores={labs[i]: float(sims[i].item()) for i in range(len(labs))},
                    image=str(img_path),
                    device=device_kind(),
                    arch=arch_key,
                )
            vec = [round(float(x), 6) for x in feats.tolist()[:16]]
            return result_text(
                text=f"image_embed[:16]={vec} dim={int(feats.numel())}",
                embedding_dim=int(feats.numel()),
                image=str(img_path),
                device=device_kind(),
                arch=arch_key,
            )
        if text.strip():
            ids = torch.tensor([tokenizer.encode(text)], dtype=torch.long, device=device)
            feats = net.encode_text(ids)[0]
            vec = [round(float(x), 6) for x in feats.tolist()[:16]]
            return result_text(
                text=f"text_embed[:16]={vec} dim={int(feats.numel())}",
                embedding_dim=int(feats.numel()),
                prompt=text,
                device=device_kind(),
                arch=arch_key,
            )
    raise SystemExit(
        "clip serve needs text and/or --image "
        '(e.g. aq serve "a cat" --image cat.png, or serve.labels for zero-shot)'
    )
