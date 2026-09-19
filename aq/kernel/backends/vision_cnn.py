"""Train / eval / inspect for family: vision, method: cnn."""

from __future__ import annotations

from protocol.paths import ckpt_dir
import json
import sys
from pathlib import Path
from typing import Any

from backends.device import device_kind, torch_device
from backends.deps import require_torch
from backends.recipe_opt import opt
from backends.vision_data import make_loader, resolve_samples, split_train_val
from neural.cnn.factory import ARCH_ALIASES, build_cnn, default_image_size, list_arches
from protocol import metrics as aq_metrics


def fit(src: Path, rec: dict) -> dict:
    torch = require_torch()
    train_root = Path(rec["_train"]) if rec.get("_train") else src.parent

    arch_raw = str(opt(rec, "arch", "resnet18", "train", "vision", "cnn") or "resnet18")
    arch_norm = arch_raw.lower().replace(" ", "").replace("_", "-")
    # normalize underscores for alias lookup
    alias_key = arch_raw.lower().replace(" ", "")
    if alias_key not in ARCH_ALIASES and alias_key.replace("-", "_") not in ARCH_ALIASES:
        # try with underscores
        if arch_raw.lower().replace("-", "_") not in ARCH_ALIASES:
            raise SystemExit(
                f"unknown cnn arch {arch_raw!r}. Supported: {', '.join(list_arches())}"
            )
    arch_key = ARCH_ALIASES.get(alias_key) or ARCH_ALIASES.get(arch_raw.lower().replace("-", "_")) or arch_raw

    samples, classes = resolve_samples(src, rec)
    if len(classes) < 2:
        raise SystemExit("need at least 2 classes")

    image_size = int(
        opt(rec, "image_size", default_image_size(arch_raw), "train", "vision", "cnn") or 224
    )
    batch = int(opt(rec, "batch_size", 32, "train", "vision", "cnn") or 32)
    lr = float(opt(rec, "lr", 1e-3, "train", "vision", "cnn") or 1e-3)
    weight_decay = float(opt(rec, "weight_decay", 1e-4, "train", "vision", "cnn") or 1e-4)
    seed = int(opt(rec, "seed", 0, "train", "vision", "cnn") or 0)
    val_frac = float(opt(rec, "val_frac", 0.1, "train", "vision", "cnn") or 0.0)
    epochs = opt(rec, "epochs", None, "train", "vision", "cnn")
    steps = opt(rec, "steps", None, "train", "vision", "cnn")
    if epochs is None and steps is None:
        epochs = 10
    workers = int(opt(rec, "num_workers", 0, "train", "vision", "cnn") or 0)
    optimizer_name = str(opt(rec, "optimizer", "adamw", "train", "vision", "cnn") or "adamw").lower()

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

    model = build_cnn(arch_raw, num_classes=len(classes), in_ch=3)
    device = torch_device()
    model.to(device)
    epochs_n = int(epochs) if epochs is not None else None
    aq_metrics.event(
        "info",
        arch=arch_key,
        classes=len(classes),
        images=len(samples),
        image_size=image_size,
        device=device_kind(),
        epochs=epochs_n,
    )

    crit = torch.nn.CrossEntropyLoss()
    params = [p for p in model.parameters() if p.requires_grad]
    if optimizer_name in ("sgd",):
        optim = torch.optim.SGD(params, lr=lr, momentum=0.9, weight_decay=weight_decay)
    else:
        optim = torch.optim.AdamW(params, lr=lr, weight_decay=weight_decay)

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
            xb = xb.to(device)
            yb = yb.to(device)
            optim.zero_grad(set_to_none=True)
            logits = model(xb)
            loss = crit(logits, yb)
            loss.backward()
            optim.step()
            running += float(loss.item())
            n_batches += 1
            pred = logits.argmax(1)
            correct += int((pred == yb).sum().item())
            total += int(yb.numel())
            global_step += 1
            last_loss = float(loss.item())
            aq_metrics.step(
                step=global_step,
                loss=last_loss,
                lr=lr,
                epoch=epoch,
                acc=correct / max(1, total),
            )
            if max_steps is not None and global_step >= max_steps:
                break
        train_loss = running / max(1, n_batches)
        train_acc = correct / max(1, total)
        payload: dict[str, Any] = {
            "epoch": epoch + 1,
            "loss": train_loss,
            "acc": train_acc,
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

    # final train accuracy pass
    model.eval()
    _, final_acc = _eval_loader(model, train_loader, crit, device)

    slot = _ckpt_slot(train_root)
    weights = slot / "model.pt"
    torch.save(
        {
            "state_dict": model.state_dict(),
            "arch": arch_raw,
            "arch_key": arch_key,
            "classes": classes,
            "image_size": image_size,
            "num_classes": len(classes),
        },
        weights,
    )
    meta = {
        "kind": "cnn",
        "backend": "aq-neural",
        "task": "image-classification",
        "family": "vision",
        "arch": arch_raw,
        "arch_key": arch_key,
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
    (slot / "cnn_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def _ckpt_slot(train: Path) -> Path:
    dest = ckpt_dir(train)
    dest.mkdir(parents=True, exist_ok=True)
    n = 1 + sum(1 for p in dest.glob("*.json") if p.name not in ("last.json",) and p.is_file())
    # also count numeric dirs
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
            xb = xb.to(device)
            yb = yb.to(device)
            logits = model(xb)
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
    arch = blob.get("arch") or model.get("arch") or "resnet18"
    classes = blob.get("classes") or model.get("classes") or []
    net = build_cnn(arch, num_classes=len(classes), in_ch=3)
    net.load_state_dict(blob["state_dict"])
    net.to(torch_device())
    net.eval()
    return net, classes, int(blob.get("image_size") or model.get("image_size") or 224)


def evaluate(model: dict, src: Path, rec: dict) -> tuple[float, int]:
    torch = require_torch()
    train = Path(rec["_train"]) if rec.get("_train") else src.parent
    net, classes, image_size = _load_model(train, model)
    samples, data_classes = resolve_samples(src, rec)
    # map labels if same names
    if data_classes != classes:
        # allow same set different order
        if set(data_classes) != set(classes):
            raise SystemExit(
                f"eval classes {data_classes} do not match train classes {classes}"
            )
        idx_map = {data_classes.index(c): classes.index(c) for c in classes}
        samples = [(p, idx_map[y]) for p, y in samples]
    batch = int(opt(rec, "batch_size", 32, "train", "vision", "cnn") or 32)
    loader = make_loader(
        samples, image_size=image_size, batch_size=batch, shuffle=False, train=False
    )
    crit = torch.nn.CrossEntropyLoss()
    metric = str((rec.get("eval") or {}).get("metric") or "accuracy").lower()
    loss, acc = _eval_loader(net, loader, crit, torch_device())
    if metric in ("loss", "nll", "ce"):
        return loss, len(samples)
    if metric in ("accuracy", "acc", "top1"):
        return acc, len(samples)
    raise SystemExit(f"cnn eval metric must be accuracy or loss, got {metric!r}")


def write_inspect(train: Path, model: dict) -> str:
    lines = [
        "# inspect",
        "",
        f"backend: {model.get('backend')}",
        f"family: {model.get('family')}",
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
        topk=[{ "label": a, "score": b} for a, b in top],
        image=str(img_path),
        device=device_kind(),
    )
