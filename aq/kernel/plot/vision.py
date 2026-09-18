"""Sample / vision grids — torchvision when available, else Pillow collage.

Looks under artifacts/samples, artifacts/previews, and recipe image folders.
Soft deps: never hard-fail the whole plot run if torch is missing.
"""

from __future__ import annotations

import json
from pathlib import Path

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
MAX_IMAGES = 64
THUMB = 128


def _pil():
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def _collect_image_paths(train: Path) -> list[Path]:
    roots = [
        train / "artifacts" / "samples",
        train / "artifacts" / "previews",
        train / "artifacts" / "plots" / "samples",
    ]
    # Recipe data.path if ImageFolder-like
    recipe = train / "recipe.yaml"
    if recipe.is_file():
        try:
            from protocol.recipe import parse_recipe

            rec = parse_recipe(recipe)
            data = rec.get("data") if isinstance(rec.get("data"), dict) else {}
            raw = data.get("path") or data.get("dir")
            if raw:
                p = Path(str(raw))
                if not p.is_absolute():
                    p = train / p
                if p.is_dir():
                    roots.append(p)
        except Exception:
            pass

    found: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
                continue
            key = str(p.resolve())
            if key in seen:
                continue
            seen.add(key)
            found.append(p)
            if len(found) >= MAX_IMAGES:
                return found
    return found


def _load_tensor_batch(train: Path):
    """Optional NCHW float tensor(s) under artifacts/samples/*.pt."""
    try:
        import torch
    except ImportError:
        return None
    root = train / "artifacts" / "samples"
    if not root.is_dir():
        return None
    tensors = []
    for p in sorted(root.glob("*.pt")) + sorted(root.glob("*.pth")):
        try:
            t = torch.load(p, map_location="cpu", weights_only=True)
        except TypeError:
            t = torch.load(p, map_location="cpu")
        except Exception:
            continue
        if hasattr(t, "dim"):
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if t.dim() == 4:
                tensors.append(t)
        if sum(x.shape[0] for x in tensors) >= MAX_IMAGES:
            break
    if not tensors:
        return None
    import torch as _torch

    batch = _torch.cat(tensors, dim=0)[:MAX_IMAGES]
    return batch


def _grid_torchvision(paths: list[Path], batch, out: Path, *, nrow: int) -> bool:
    try:
        import torch
        from torchvision.utils import make_grid, save_image
        from torchvision.transforms.functional import to_tensor, resize
    except ImportError:
        return False

    Image = _pil()
    tensors = []
    if batch is not None:
        b = batch
        if b.dtype != torch.float32:
            b = b.float()
        if b.max() > 1.5:
            b = b / 255.0
        tensors.append(b)
    if paths and Image is not None:
        for p in paths:
            try:
                img = Image.open(p).convert("RGB")
                t = to_tensor(resize(img, [THUMB, THUMB]))
                tensors.append(t.unsqueeze(0))
            except Exception:
                continue
    if not tensors:
        return False
    batch_t = torch.cat(tensors, dim=0)[:MAX_IMAGES]
    grid = make_grid(batch_t, nrow=nrow, padding=2, normalize=True, value_range=(0, 1))
    out.parent.mkdir(parents=True, exist_ok=True)
    save_image(grid, str(out))
    return True


def _grid_pil(paths: list[Path], out: Path, *, nrow: int) -> bool:
    Image = _pil()
    if Image is None or not paths:
        return False
    thumbs = []
    for p in paths[:MAX_IMAGES]:
        try:
            img = Image.open(p).convert("RGB")
            img = img.resize((THUMB, THUMB), Image.Resampling.BILINEAR)
            thumbs.append(img)
        except Exception:
            continue
    if not thumbs:
        return False
    n = len(thumbs)
    cols = max(1, min(nrow, n))
    rows = (n + cols - 1) // cols
    pad = 2
    canvas = Image.new(
        "RGB",
        (cols * THUMB + (cols + 1) * pad, rows * THUMB + (rows + 1) * pad),
        (250, 250, 250),
    )
    for i, img in enumerate(thumbs):
        r, c = divmod(i, cols)
        canvas.paste(img, (pad + c * (THUMB + pad), pad + r * (THUMB + pad)))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    return True


def _rel(train: Path, p: Path) -> str:
    try:
        return str(p.resolve().relative_to(train.resolve()))
    except ValueError:
        return str(p)


def _write_meta(out_dir: Path, *, backend: str, n: int, sources: list[str]) -> None:
    meta = {
        "kind": "samples",
        "backend": backend,
        "n": n,
        "sources": sources[:20],
    }
    (out_dir / "samples.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def plot_vision(train: Path, out_dir: Path, *, fmt: str, dpi: int) -> Path | None:
    """Write artifacts/plots/samples.png (or .fmt). Returns path or None if nothing to draw."""
    del dpi  # torchvision/PIL save their own; keep signature aligned with other plotters
    paths = _collect_image_paths(train)
    batch = _load_tensor_batch(train)
    if not paths and batch is None:
        return None

    # Prefer png for image grids even if fmt is svg/pdf (grids are raster)
    ext = "png" if fmt in ("svg", "pdf") else fmt
    out = out_dir / f"samples.{ext}"
    nrow = 8
    srcs = [_rel(train, p) for p in paths[:12]]

    if _grid_torchvision(paths, batch, out, nrow=nrow):
        n = min(MAX_IMAGES, (int(batch.shape[0]) if batch is not None else 0) + len(paths))
        _write_meta(out_dir, backend="torchvision", n=n, sources=srcs)
        return out

    if _grid_pil(paths, out, nrow=nrow):
        _write_meta(out_dir, backend="pillow", n=min(MAX_IMAGES, len(paths)), sources=srcs)
        return out

    # Last resort: matplotlib montage if PIL missing but paths exist
    if not paths:
        return None
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.image as mpimg
    except ImportError:
        return None

    n = min(len(paths), MAX_IMAGES)
    cols = min(8, n)
    rows = (n + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 1.4, rows * 1.4))
    axes_flat = list(axes.flat) if hasattr(axes, "flat") else [axes]
    for i, ax in enumerate(axes_flat):
        ax.axis("off")
        if i < n:
            try:
                ax.imshow(mpimg.imread(paths[i]))
            except Exception:
                pass
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)
    _write_meta(out_dir, backend="matplotlib", n=n, sources=srcs)
    return out


# Alias used by registry
plot_samples = plot_vision
