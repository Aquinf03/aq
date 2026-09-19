"""Train / eval / inspect for family: vision, method: vit (ViT / Swin / DeiT / BEiT)."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import json
from pathlib import Path
from typing import Any

from backends.device import device_kind, torch_device
from backends.deps import require_torch
from backends.recipe_opt import opt
from backends.vision_data import make_loader, resolve_samples, split_train_val
from neural.cnn.factory import build_cnn
from neural.vit.beit import BEiT, blockwise_mask
from neural.vit.deit import DistilledVisionTransformer, deit_loss
from neural.vit.factory import (
    build_vit,
    default_image_size,
    default_weight_decay,
    family_of,
    resolve_arch,
)
from neural.vit.vqvae import DiscreteVAE
from protocol import metrics as aq_metrics


def fit(src: Path, rec: dict) -> dict:
    torch = require_torch()
    train_root = Path(rec["_train"]) if rec.get("_train") else src.parent

    arch_raw = str(opt(rec, "arch", "vit-b/16", "train", "vision", "vit") or "vit-b/16")
    arch_key = resolve_arch(arch_raw)
    fam = family_of(arch_key)

    samples, classes = resolve_samples(src, rec)
    if len(classes) < 2:
        raise SystemExit("need at least 2 classes")

    image_size = int(
        opt(rec, "image_size", default_image_size(arch_raw), "train", "vision", "vit") or 224
    )
    if fam == "swin" and image_size % 32 != 0:
        raise SystemExit(f"swin requires image_size divisible by 32, got {image_size}")
    if fam in ("vit", "deit", "beit") and image_size % 16 != 0:
        raise SystemExit(f"{fam} requires image_size divisible by 16, got {image_size}")

    batch = int(opt(rec, "batch_size", 32, "train", "vision", "vit") or 32)
    lr = float(opt(rec, "lr", 1e-3, "train", "vision", "vit") or 1e-3)
    weight_decay = float(
        opt(rec, "weight_decay", default_weight_decay(arch_raw), "train", "vision", "vit") or 0.05
    )
    seed = int(opt(rec, "seed", 0, "train", "vision", "vit") or 0)
    val_frac = float(opt(rec, "val_frac", 0.1, "train", "vision", "vit") or 0.0)
    epochs = opt(rec, "epochs", None, "train", "vision", "vit")
    steps = opt(rec, "steps", None, "train", "vision", "vit")
    if epochs is None and steps is None:
        epochs = 10
    workers = int(opt(rec, "num_workers", 0, "train", "vision", "vit") or 0)
    vocab_size = int(opt(rec, "vocab_size", 8192, "train", "vision", "vit") or 8192)

    torch.manual_seed(seed)
    train_s, val_s = split_train_val(samples, val_frac, seed)
    train_loader = make_loader(
        train_s, image_size=image_size, batch_size=batch, shuffle=True, train=True, num_workers=workers
    )
    val_loader = (
        make_loader(
            val_s, image_size=image_size, batch_size=batch, shuffle=False, train=False, num_workers=workers
        )
        if val_s
        else None
    )

    device = torch_device()
    epochs_n = int(epochs) if epochs is not None else None
    aq_metrics.event(
        "info",
        arch=arch_key,
        family=fam,
        classes=len(classes),
        images=len(samples),
        image_size=image_size,
        device=device_kind(),
        epochs=epochs_n,
    )

    if fam == "beit":
        meta = _fit_beit(
            train_root=train_root,
            rec=rec,
            arch_raw=arch_raw,
            arch_key=arch_key,
            classes=classes,
            samples=samples,
            train_s=train_s,
            val_s=val_s,
            train_loader=train_loader,
            val_loader=val_loader,
            image_size=image_size,
            batch=batch,
            lr=lr,
            weight_decay=weight_decay,
            epochs=epochs,
            steps=steps,
            vocab_size=vocab_size,
            device=device,
            workers=workers,
        )
        return meta

    if fam == "deit":
        meta = _fit_deit(
            train_root=train_root,
            rec=rec,
            arch_raw=arch_raw,
            arch_key=arch_key,
            classes=classes,
            samples=samples,
            train_s=train_s,
            val_s=val_s,
            train_loader=train_loader,
            val_loader=val_loader,
            image_size=image_size,
            lr=lr,
            weight_decay=weight_decay,
            epochs=epochs,
            steps=steps,
            device=device,
        )
        return meta

    # ViT / Swin supervised
    model = build_vit(arch_raw, num_classes=len(classes), img_size=image_size)
    model.to(device)
    return _fit_classify(
        model=model,
        train_root=train_root,
        arch_raw=arch_raw,
        arch_key=arch_key,
        fam=fam,
        classes=classes,
        samples=samples,
        train_s=train_s,
        val_s=val_s,
        train_loader=train_loader,
        val_loader=val_loader,
        image_size=image_size,
        lr=lr,
        weight_decay=weight_decay,
        epochs=epochs,
        steps=steps,
        device=device,
        task="image-classification",
    )


def _optimizer(torch, model, lr, weight_decay):
    params = [p for p in model.parameters() if p.requires_grad]
    return torch.optim.AdamW(params, lr=lr, weight_decay=weight_decay)


def _fit_classify(
    *,
    model,
    train_root: Path,
    arch_raw: str,
    arch_key: str,
    fam: str,
    classes: list[str],
    samples,
    train_s,
    val_s,
    train_loader,
    val_loader,
    image_size: int,
    lr: float,
    weight_decay: float,
    epochs,
    steps,
    device,
    task: str,
    extra_ckpt: dict | None = None,
) -> dict:
    torch = require_torch()
    crit = torch.nn.CrossEntropyLoss()
    optim = _optimizer(torch, model, lr, weight_decay)
    max_steps = int(steps) if steps is not None else None
    n_epochs = int(epochs) if epochs is not None else 10**9
    global_step = 0
    last_loss = None
    best_val = None

    model.train()
    for epoch in range(n_epochs):
        running = 0.0
        n_batches = 0
        correct = 0
        total = 0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optim.zero_grad(set_to_none=True)
            logits = model(xb)
            if isinstance(logits, tuple):
                logits = (logits[0] + logits[1]) / 2
            loss = crit(logits, yb)
            loss.backward()
            optim.step()
            running += float(loss.item())
            n_batches += 1
            correct += int((logits.argmax(1) == yb).sum().item())
            total += int(yb.numel())
            global_step += 1
            last_loss = float(loss.item())
            aq_metrics.step(
                step=global_step, loss=last_loss, lr=lr, epoch=epoch, acc=correct / max(1, total)
            )
            if max_steps is not None and global_step >= max_steps:
                break
        payload: dict[str, Any] = {
            "epoch": epoch + 1,
            "loss": running / max(1, n_batches),
            "acc": correct / max(1, total),
        }
        if val_loader is not None:
            v_loss, v_acc = _eval_loader(model, val_loader, crit, device)
            payload["val_loss"] = v_loss
            payload["val_acc"] = v_acc
            best_val = v_acc if best_val is None else max(best_val, v_acc)
            model.train()
        aq_metrics.event("epoch", **payload)
        if max_steps is not None and global_step >= max_steps:
            break

    model.eval()
    _, final_acc = _eval_loader(model, train_loader, crit, device)
    slot = _ckpt_slot(train_root)
    weights = slot / "model.pt"
    blob = {
        "state_dict": model.state_dict(),
        "arch": arch_raw,
        "arch_key": arch_key,
        "classes": classes,
        "image_size": image_size,
        "num_classes": len(classes),
        "family": fam,
    }
    if extra_ckpt:
        blob.update(extra_ckpt)
    torch.save(blob, weights)
    meta = {
        "kind": "vit",
        "backend": "aq-neural",
        "task": task,
        "family": "vision",
        "arch": arch_raw,
        "arch_key": arch_key,
        "vit_family": fam,
        "classes": classes,
        "num_classes": len(classes),
        "image_size": image_size,
        "n_images": len(samples),
        "n_train": len(train_s),
        "n_val": len(val_s),
        "train_loss": last_loss,
        "train_acc": final_acc,
        "val_acc": best_val,
        "steps": global_step,
        "lr": lr,
        "device": device_kind(),
        "params": sum(p.numel() for p in model.parameters()),
        "weights_path": str(weights.relative_to(train_root)),
        "weights_dir": str(slot.relative_to(train_root)),
    }
    if extra_ckpt and extra_ckpt.get("vq_path"):
        meta["vq_path"] = extra_ckpt["vq_path"]
        meta["vocab_size"] = extra_ckpt.get("vocab_size")
    (slot / "vit_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def _fit_deit(**kw) -> dict:
    torch = require_torch()
    rec = kw["rec"]
    device = kw["device"]
    classes = kw["classes"]
    image_size = kw["image_size"]
    train_loader = kw["train_loader"]
    arch_raw = kw["arch_raw"]
    arch_key = kw["arch_key"]

    teacher_arch = str(opt(rec, "teacher", "resnet50", "train", "vision", "vit") or "resnet50")
    teacher_epochs = int(opt(rec, "teacher_epochs", 3, "train", "vision", "vit") or 3)
    alpha = float(opt(rec, "distill_alpha", 0.5, "train", "vision", "vit") or 0.5)
    temp = float(opt(rec, "distill_temp", 3.0, "train", "vision", "vit") or 3.0)
    lr = kw["lr"]
    weight_decay = kw["weight_decay"]
    epochs = kw["epochs"]
    steps = kw["steps"]

    teacher = build_cnn(teacher_arch, num_classes=len(classes), in_ch=3)
    teacher.to(device)
    # warm teacher on the same data (real distillation needs a competent teacher)
    aq_metrics.event("info", phase="teacher", teacher=teacher_arch, teacher_epochs=teacher_epochs)
    t_crit = torch.nn.CrossEntropyLoss()
    t_opt = torch.optim.AdamW(teacher.parameters(), lr=lr, weight_decay=1e-4)
    teacher.train()
    for ep in range(max(1, teacher_epochs)):
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            t_opt.zero_grad(set_to_none=True)
            loss = t_crit(teacher(xb), yb)
            loss.backward()
            t_opt.step()
        aq_metrics.event("epoch", epoch=ep + 1, phase="teacher", loss=float(loss.item()))
    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad_(False)

    student = build_vit(arch_raw, num_classes=len(classes), img_size=image_size)
    assert isinstance(student, DistilledVisionTransformer)
    student.to(device)
    optim = _optimizer(torch, student, lr, weight_decay)

    max_steps = int(steps) if steps is not None else None
    n_epochs = int(epochs) if epochs is not None else 10**9
    global_step = 0
    last_loss = None
    best_val = None
    crit = torch.nn.CrossEntropyLoss()

    student.train()
    for epoch in range(n_epochs):
        running = 0.0
        n_batches = 0
        correct = 0
        total = 0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optim.zero_grad(set_to_none=True)
            with torch.no_grad():
                t_logits = teacher(xb)
            logits_cls, logits_dist = student(xb)
            loss = deit_loss(
                logits_cls, logits_dist, yb, t_logits, temperature=temp, alpha=alpha
            )
            loss.backward()
            optim.step()
            running += float(loss.item())
            n_batches += 1
            pred = ((logits_cls + logits_dist) / 2).argmax(1)
            correct += int((pred == yb).sum().item())
            total += int(yb.numel())
            global_step += 1
            last_loss = float(loss.item())
            aq_metrics.step(
                step=global_step, loss=last_loss, lr=lr, epoch=epoch, acc=correct / max(1, total)
            )
            if max_steps is not None and global_step >= max_steps:
                break
        payload: dict[str, Any] = {
            "epoch": epoch + 1,
            "loss": running / max(1, n_batches),
            "acc": correct / max(1, total),
        }
        if kw["val_loader"] is not None:
            v_loss, v_acc = _eval_loader(student, kw["val_loader"], crit, device)
            payload["val_loss"] = v_loss
            payload["val_acc"] = v_acc
            best_val = v_acc if best_val is None else max(best_val, v_acc)
            student.train()
        aq_metrics.event("epoch", **payload)
        if max_steps is not None and global_step >= max_steps:
            break

    student.eval()
    _, final_acc = _eval_loader(student, train_loader, crit, device)
    slot = _ckpt_slot(kw["train_root"])
    weights = slot / "model.pt"
    torch.save(
        {
            "state_dict": student.state_dict(),
            "arch": arch_raw,
            "arch_key": arch_key,
            "classes": classes,
            "image_size": image_size,
            "num_classes": len(classes),
            "family": "deit",
            "teacher": teacher_arch,
        },
        weights,
    )
    meta = {
        "kind": "vit",
        "backend": "aq-neural",
        "task": "image-classification",
        "family": "vision",
        "arch": arch_raw,
        "arch_key": arch_key,
        "vit_family": "deit",
        "teacher": teacher_arch,
        "classes": classes,
        "num_classes": len(classes),
        "image_size": image_size,
        "n_images": len(kw["samples"]),
        "n_train": len(kw["train_s"]),
        "n_val": len(kw["val_s"]),
        "train_loss": last_loss,
        "train_acc": final_acc,
        "val_acc": best_val,
        "steps": global_step,
        "lr": lr,
        "device": device_kind(),
        "params": sum(p.numel() for p in student.parameters()),
        "weights_path": str(weights.relative_to(kw["train_root"])),
        "weights_dir": str(slot.relative_to(kw["train_root"])),
    }
    (slot / "vit_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def _fit_beit(**kw) -> dict:
    """VQ tokenizer → blockwise MIM → classification fine-tune."""
    torch = require_torch()
    rec = kw["rec"]
    device = kw["device"]
    image_size = kw["image_size"]
    vocab_size = kw["vocab_size"]
    train_loader = kw["train_loader"]
    lr = kw["lr"]
    weight_decay = kw["weight_decay"]
    classes = kw["classes"]
    arch_raw = kw["arch_raw"]
    arch_key = kw["arch_key"]
    train_root = kw["train_root"]

    epochs = kw["epochs"]
    steps = kw["steps"]
    total_epochs = int(epochs) if epochs is not None else 10
    vq_epochs = int(opt(rec, "vq_epochs", max(1, total_epochs // 3), "train", "vision", "vit") or 1)
    mim_epochs = int(opt(rec, "mim_epochs", max(1, total_epochs // 3), "train", "vision", "vit") or 1)
    ft_epochs = int(
        opt(rec, "classify_epochs", max(1, total_epochs - vq_epochs - mim_epochs), "train", "vision", "vit")
        or 1
    )
    mask_ratio = float(opt(rec, "mask_ratio", 0.4, "train", "vision", "vit") or 0.4)
    max_steps = int(steps) if steps is not None else None

    # ── 1. discrete VAE tokenizer ──────────────────────────────────────────
    vq = DiscreteVAE(n_embed=vocab_size, patch=16)
    vq.to(device)
    vq_opt = torch.optim.AdamW(vq.parameters(), lr=lr, weight_decay=1e-4)
    aq_metrics.event("info", phase="vq", vocab_size=vocab_size, vq_epochs=vq_epochs)
    step = 0
    vq.train()
    for ep in range(vq_epochs):
        last = 0.0
        for xb, _ in train_loader:
            xb = xb.to(device)
            vq_opt.zero_grad(set_to_none=True)
            _, loss, _ = vq(xb)
            loss.backward()
            vq_opt.step()
            last = float(loss.item())
            step += 1
            aq_metrics.step(step=step, loss=last, lr=lr, epoch=ep, phase="vq")
            if max_steps is not None and step >= max_steps:
                break
        aq_metrics.event("epoch", epoch=ep + 1, phase="vq", loss=last)
        if max_steps is not None and step >= max_steps:
            break
    vq.eval()
    for p in vq.parameters():
        p.requires_grad_(False)

    # ── 2. BEiT MIM ────────────────────────────────────────────────────────
    model = build_vit(
        arch_raw, num_classes=len(classes), img_size=image_size, vocab_size=vocab_size
    )
    assert isinstance(model, BEiT)
    model.to(device)
    mim_opt = _optimizer(torch, model, lr, weight_decay)
    aq_metrics.event("info", phase="mim", mim_epochs=mim_epochs, mask_ratio=mask_ratio)
    model.train()
    grid = image_size // 16
    for ep in range(mim_epochs):
        if max_steps is not None and step >= max_steps:
            break
        last = 0.0
        for xb, _ in train_loader:
            xb = xb.to(device)
            with torch.no_grad():
                tokens = vq.tokenize(xb)
            # tokens spatial must match patch grid
            if tokens.shape[-1] != grid:
                # rare resize mismatch — nearest to grid
                tokens = torch.nn.functional.interpolate(
                    tokens.float().unsqueeze(1), size=(grid, grid), mode="nearest"
                ).long().squeeze(1)
            mask = blockwise_mask(xb.shape[0], grid, mask_ratio=mask_ratio, device=device)
            mim_opt.zero_grad(set_to_none=True)
            loss = model.forward_mim(xb, mask, tokens)
            loss.backward()
            mim_opt.step()
            last = float(loss.item())
            step += 1
            aq_metrics.step(step=step, loss=last, lr=lr, epoch=ep, phase="mim")
            if max_steps is not None and step >= max_steps:
                break
        aq_metrics.event("epoch", epoch=ep + 1, phase="mim", loss=last)

    # ── 3. classification fine-tune ────────────────────────────────────────
    aq_metrics.event("info", phase="classify", classify_epochs=ft_epochs)
    return _fit_classify(
        model=model,
        train_root=train_root,
        arch_raw=arch_raw,
        arch_key=arch_key,
        fam="beit",
        classes=classes,
        samples=kw["samples"],
        train_s=kw["train_s"],
        val_s=kw["val_s"],
        train_loader=train_loader,
        val_loader=kw["val_loader"],
        image_size=image_size,
        lr=lr,
        weight_decay=weight_decay,
        epochs=ft_epochs,
        steps=None if max_steps is None else max(1, max_steps - step),
        device=device,
        task="beit-mim+classify",
        extra_ckpt={
            "vocab_size": vocab_size,
            "vq_state_dict": vq.state_dict(),
        },
    )


def _ckpt_slot(train: Path) -> Path:
    dest = ckpt_dir(train)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name not in ("last.json",) and p.is_file())
    n = max(n, 1 + sum(1 for p in dest.iterdir() if p.is_dir() and p.name.isdigit()))
    slot = dest / str(n)
    slot.mkdir(parents=True, exist_ok=True)
    return slot


def _eval_loader(model, loader, crit, device) -> tuple[float, float]:
    import torch

    model.eval()
    total_loss = 0.0
    n_batches = 0
    correct = 0
    total = 0
    with torch.no_grad():
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            logits = model(xb)
            if isinstance(logits, tuple):
                logits = (logits[0] + logits[1]) / 2
            loss = crit(logits, yb)
            total_loss += float(loss.item())
            n_batches += 1
            correct += int((logits.argmax(1) == yb).sum().item())
            total += int(yb.numel())
    return total_loss / max(1, n_batches), correct / max(1, total)


def _load_model(train: Path, model: dict):
    torch = require_torch()
    rel = model.get("weights_path")
    if not rel:
        raise SystemExit("checkpoint missing weights_path")
    path = train / str(rel)
    if not path.is_file():
        raise SystemExit(f"weights not found: {rel}")
    blob = torch.load(path, map_location="cpu", weights_only=False)
    arch = blob.get("arch") or model.get("arch") or "vit-b/16"
    classes = blob.get("classes") or model.get("classes") or []
    image_size = int(blob.get("image_size") or model.get("image_size") or 224)
    vocab = int(blob.get("vocab_size") or model.get("vocab_size") or 8192)
    net = build_vit(arch, num_classes=len(classes), img_size=image_size, vocab_size=vocab)
    net.load_state_dict(blob["state_dict"])
    net.to(torch_device())
    net.eval()
    return net, classes, image_size


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else src.parent
    net, classes, image_size = _load_model(train, model)
    samples, data_classes = resolve_samples(src, rec)
    if data_classes != classes:
        if set(data_classes) != set(classes):
            raise SystemExit(f"eval classes {data_classes} do not match train classes {classes}")
        idx_map = {data_classes.index(c): classes.index(c) for c in classes}
        samples = [(p, idx_map[y]) for p, y in samples]
    batch = int(opt(rec, "batch_size", 32, "train", "vision", "vit") or 32)
    loader = make_loader(samples, image_size=image_size, batch_size=batch, shuffle=False, train=False)
    crit = torch.nn.CrossEntropyLoss()
    metric = str((rec.get("eval") or {}).get("metric") or "accuracy").lower()
    loss, acc = _eval_loader(net, loader, crit, torch_device())
    if metric in ("loss", "nll", "ce"):
        return loss, len(samples)
    if metric in ("accuracy", "acc", "top1"):
        return acc, len(samples)
    raise SystemExit(f"vit eval metric must be accuracy or loss, got {metric!r}")


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"family: {model.get('family')}",
        f"vit_family: {model.get('vit_family')}",
        f"arch: {model.get('arch')} ({model.get('arch_key')})",
        f"task: {model.get('task')}",
        f"classes ({model.get('num_classes')}): {', '.join(model.get('classes') or [])}",
        f"image_size: {model.get('image_size')}",
        f"params: {model.get('params')}",
        f"train_loss: {model.get('train_loss')}",
        f"train_acc: {model.get('train_acc')}",
        f"val_acc: {model.get('val_acc')}",
        f"steps: {model.get('steps')}",
        f"device: {model.get('device')}",
        f"weights: {model.get('weights_path')}",
        "",
    ]
    if model.get("teacher"):
        lines.insert(-1, f"teacher: {model.get('teacher')}")
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
    del max_tokens, temperature
    torch = require_torch()
    from torch.nn import functional as F

    train = Path(rec["_train"]) if rec.get("_train") else Path.cwd()
    from backends.serve_io import resolve_image, result_text
    from backends.vlm_data import load_image_tensor

    img_path, _ = resolve_image(prompt, rec, image=rec.get("_serve_image"))
    if img_path is None:
        raise SystemExit(
            "vision serve needs an image path as prompt or --image "
            "(e.g. aq serve data/cat.png or aq serve --image data/cat.png)"
        )
    net, classes, image_size = _load_model(train, model)
    device = torch_device()
    x = load_image_tensor(img_path, image_size, train=False).unsqueeze(0).to(device)
    with torch.no_grad():
        logits = net(x)[0]
        probs = F.softmax(logits, dim=-1)
        idx = int(probs.argmax().item())
        conf = float(probs[idx].item())
    label = classes[idx] if idx < len(classes) else str(idx)
    top = sorted(
        ((classes[i] if i < len(classes) else str(i), float(probs[i].item())) for i in range(probs.numel())),
        key=lambda t: -t[1],
    )[:5]
    return result_text(
        text=label,
        label=label,
        score=conf,
        topk=[{"label": a, "score": b} for a, b in top],
        image=str(img_path),
        device=device_kind(),
    )
