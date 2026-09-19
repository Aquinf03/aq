"""Sample / vision grids — torchvision when available, else Pillow collage.

Looks under artifacts/samples, artifacts/previews, recipe image folders,
or dirs listed in plot.samples.dirs / --from.
"""

from __future__ import annotations

from protocol.paths import art_dir
import json
from pathlib import Path
from typing import Any

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def _pil():
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def _collect_image_paths(train: Path, *, dirs: list[str] | None, max_images: int) -> list[Path]:
    roots: list[Path] = []
    if dirs:
        for d in dirs:
            p = Path(d)
            if not p.is_absolute():
                p = train / p
            roots.append(p)
    else:
        roots = [
            art_dir(train) /  "samples",
            art_dir(train) /  "previews",
            art_dir(train) /  "plots" / "samples",
        ]
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
            if len(found) >= max_images:
                return found
    return found


def _load_tensor_batch(train: Path, *, max_images: int):
    try:
        import torch
    except ImportError:
        return None
    root = art_dir(train) /  "samples"
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
        if sum(x.shape[0] for x in tensors) >= max_images:
            break
    if not tensors:
        return None
    import torch as _torch

    return _torch.cat(tensors, dim=0)[:max_images]


def _grid_torchvision(
    paths: list[Path],
    batch,
    out: Path,
    *,
    nrow: int,
    thumb: int,
    max_images: int,
) -> bool:
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
                t = to_tensor(resize(img, [thumb, thumb]))
                tensors.append(t.unsqueeze(0))
            except Exception:
                continue
    if not tensors:
        return False
    batch_t = torch.cat(tensors, dim=0)[:max_images]
    grid = make_grid(batch_t, nrow=nrow, padding=2, normalize=True, value_range=(0, 1))
    out.parent.mkdir(parents=True, exist_ok=True)
    save_image(grid, str(out))
    return True


def _grid_pil(paths: list[Path], out: Path, *, nrow: int, thumb: int, max_images: int) -> bool:
    Image = _pil()
    if Image is None or not paths:
        return False
    thumbs = []
    for p in paths[:max_images]:
        try:
            img = Image.open(p).convert("RGB")
            img = img.resize((thumb, thumb), Image.Resampling.BILINEAR)
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
        (cols * thumb + (cols + 1) * pad, rows * thumb + (rows + 1) * pad),
        (250, 250, 250),
    )
    for i, img in enumerate(thumbs):
        r, c = divmod(i, cols)
        canvas.paste(img, (pad + c * (thumb + pad), pad + r * (thumb + pad)))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    return True


def _rel(train: Path, p: Path) -> str:
    try:
        return str(p.resolve().relative_to(train.resolve()))
    except ValueError:
        return str(p)


def _write_meta(out_dir: Path, *, backend: str, n: int, sources: list[str], opts: dict[str, Any]) -> None:
    meta = {
        "kind": "samples",
        "backend": backend,
        "n": n,
        "sources": sources[:20],
        "opts": {k: opts.get(k) for k in ("max", "thumb", "nrow", "dirs", "backend") if k in opts},
    }
    (out_dir / "samples.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def plot_vision(
    train: Path,
    out_dir: Path,
    *,
    fmt: str,
    dpi: int,
    opts: dict[str, Any] | None = None,
) -> Path | None:
    opts = opts or {}
    max_images = int(opts.get("max") or 64)
    thumb = int(opts.get("thumb") or 128)
    nrow = int(opts.get("nrow") or 8)
    backend = str(opts.get("backend") or "auto").lower()
    dirs = opts.get("dirs")
    if isinstance(dirs, str):
        dirs = [d.strip() for d in dirs.split(",") if d.strip()]

    paths = _collect_image_paths(train, dirs=dirs, max_images=max_images)
    batch = _load_tensor_batch(train, max_images=max_images)
    if not paths and batch is None:
        return None

    ext = "png" if fmt in ("svg", "pdf") else fmt
    out = out_dir / f"samples.{ext}"
    srcs = [_rel(train, p) for p in paths[:12]]
    prefer = []
    if backend == "torchvision":
        prefer = ["torchvision"]
    elif backend == "pillow":
        prefer = ["pillow"]
    elif backend == "matplotlib":
        prefer = ["matplotlib"]
    else:
        prefer = ["torchvision", "pillow", "matplotlib"]

    for b in prefer:
        if b == "torchvision" and _grid_torchvision(
            paths, batch, out, nrow=nrow, thumb=thumb, max_images=max_images
        ):
            n = min(max_images, (int(batch.shape[0]) if batch is not None else 0) + len(paths))
            _write_meta(out_dir, backend="torchvision", n=n, sources=srcs, opts=opts)
            return out
        if b == "pillow" and _grid_pil(paths, out, nrow=nrow, thumb=thumb, max_images=max_images):
            _write_meta(out_dir, backend="pillow", n=min(max_images, len(paths)), sources=srcs, opts=opts)
            return out
        if b == "matplotlib" and paths:
            try:
                import matplotlib

                matplotlib.use("Agg")
                import matplotlib.pyplot as plt
                import matplotlib.image as mpimg
            except ImportError:
                continue
            n = min(len(paths), max_images)
            cols = min(nrow, n)
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
            fig.savefig(out, dpi=dpi or 120, bbox_inches="tight")
            plt.close(fig)
            _write_meta(out_dir, backend="matplotlib", n=n, sources=srcs, opts=opts)
            return out
    return None


plot_samples = plot_vision
