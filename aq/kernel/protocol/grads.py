"""Gradient & param norms — debug train dynamics without custom hooks.

Opt-in:

  capture:
    grads: true          # or gradients: true
    grads_every: 25      # optional (default 50)

  aq train --grads
  AQ_CAPTURE_GRADS=1 / AQ_GRADS=1

  from aquin import log_grads, enable_grads

Emits ``grads`` events (grad_norm / param_norm + compact summaries) into
``artifacts/metrics.jsonl`` and the train TUI. Skips sklearn (no grads).
"""

from __future__ import annotations

import math
import os
from typing import Any, Iterable

_enabled = False
_every = 50
_top_k = 3
_last_step = -1
_rec: dict | None = None
_req: dict | None = None


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in (
        "true",
        "yes",
        "on",
        "1",
        "grads",
        "gradients",
        "grad",
    )


def want(rec: dict | None = None, req: dict | None = None) -> bool:
    """req > env > recipe capture.grads / capture.gradients."""
    if req is not None:
        if "capture_grads" in req:
            return _truthy(req.get("capture_grads"))
        if "grads" in req and req.get("grads") is not None:
            return _truthy(req.get("grads"))
    for key in ("AQ_CAPTURE_GRADS", "AQ_GRADS"):
        env = os.environ.get(key, "").strip().lower()
        if env in ("1", "true", "yes", "on"):
            return True
        if env in ("0", "false", "no", "off"):
            return False
    if isinstance(rec, dict):
        raw = rec.get("capture")
        if isinstance(raw, dict):
            if "grads" in raw:
                return _truthy(raw.get("grads"))
            if "gradients" in raw:
                return _truthy(raw.get("gradients"))
    return False


def _every_from(rec: dict | None, req: dict | None) -> int:
    for src in (req, (rec or {}).get("capture") if isinstance(rec, dict) else None):
        if not isinstance(src, dict):
            continue
        for key in ("grads_every", "grad_every", "every"):
            if key in src and src.get(key) is not None:
                try:
                    return max(1, int(src[key]))
                except (TypeError, ValueError):
                    pass
    env = os.environ.get("AQ_GRADS_EVERY", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return 50


def enabled() -> bool:
    return _enabled


def enable(rec: dict | None = None, req: dict | None = None, *, every: int | None = None) -> None:
    """Turn on session sampling (call from do_train when want())."""
    global _enabled, _every, _last_step, _rec, _req, _top_k
    _rec, _req = rec, req
    _every = int(every) if every is not None else _every_from(rec, req)
    _last_step = -1
    _enabled = True
    raw = (rec or {}).get("capture") if isinstance(rec, dict) else None
    if isinstance(raw, dict) and raw.get("grads_top") is not None:
        try:
            _top_k = max(0, int(raw.get("grads_top")))
        except (TypeError, ValueError):
            pass
    # Ensure Optimizer.step is patched so custom torch loops get norms.
    try:
        from protocol.integrations import torch_hook

        torch_hook.apply(force=True)
    except Exception:
        pass


def disable() -> None:
    global _enabled, _last_step
    _enabled = False
    _last_step = -1


def should_sample(step: int | None) -> bool:
    if not _enabled:
        return False
    if step is None:
        return True
    s = int(step)
    if s == _last_step:
        return False
    return s == 0 or s == 1 or s % _every == 0


def sample_parameters(
    params: Iterable[Any],
    *,
    names: list[str] | None = None,
) -> dict[str, Any]:
    """Global grad/param L2 norms + optional top-k layer grad norms."""
    try:
        import torch
    except ImportError:
        return {}

    g_sq = 0.0
    p_sq = 0.0
    n_grad = 0
    n_param = 0
    g_sum = 0.0
    g_sumsq = 0.0
    p_sum = 0.0
    p_sumsq = 0.0
    layer_grads: list[tuple[str, float]] = []

    named = names
    for i, p in enumerate(params):
        if p is None or not hasattr(p, "data"):
            continue
        try:
            pdata = p.data.detach()
            if pdata.numel() == 0:
                continue
            # float stats on a flattened view (CPU copy only if needed for sum)
            pf = pdata.float()
            pn = float(_vec_norm(pf).item())
            p_sq += pn * pn
            n_param += int(pf.numel())
            # reservoir-free running mean/var via sum — use mean of tensor
            p_mean = float(pf.mean().item())
            p_sum += p_mean * pf.numel()
            p_sumsq += float((pf * pf).sum().item())
            name = named[i] if named and i < len(named) else None
            grad = getattr(p, "grad", None)
            if grad is not None:
                gf = grad.detach().float()
                gn = float(_vec_norm(gf).item())
                g_sq += gn * gn
                n_grad += int(gf.numel())
                g_sum += float(gf.mean().item()) * gf.numel()
                g_sumsq += float((gf * gf).sum().item())
                if name and _top_k > 0:
                    layer_grads.append((name, gn))
        except Exception:
            continue

    if n_param == 0:
        return {}

    out: dict[str, Any] = {
        "param_norm": round(math.sqrt(p_sq), 6),
        "n_param": n_param,
    }
    if n_param > 0:
        p_mean = p_sum / n_param
        out["param_mean"] = round(p_mean, 6)
        var = max(0.0, p_sumsq / n_param - p_mean * p_mean)
        out["param_std"] = round(math.sqrt(var), 6)
    if n_grad > 0:
        out["grad_norm"] = round(math.sqrt(g_sq), 6)
        out["n_grad"] = n_grad
        g_mean = g_sum / n_grad
        out["grad_mean"] = round(g_mean, 6)
        gvar = max(0.0, g_sumsq / n_grad - g_mean * g_mean)
        out["grad_std"] = round(math.sqrt(gvar), 6)

    if layer_grads and _top_k > 0:
        layer_grads.sort(key=lambda x: x[1], reverse=True)
        top = layer_grads[:_top_k]
        out["grad_top"] = ",".join(f"{_short_name(n)}:{v:.3g}" for n, v in top)

    # Compact TUI strings
    bits = []
    if out.get("grad_norm") is not None:
        bits.append(f"‖g‖={out['grad_norm']:.4g}")
    if out.get("param_norm") is not None:
        bits.append(f"‖θ‖={out['param_norm']:.4g}")
    if out.get("grad_std") is not None:
        bits.append(f"gσ={out['grad_std']:.3g}")
    if bits:
        out["grad_s"] = " ".join(bits)
    return out


def sample_model(model: Any) -> dict[str, Any]:
    try:
        named = list(model.named_parameters())
    except Exception:
        try:
            return sample_parameters(model.parameters())
        except Exception:
            return {}
    return sample_parameters((p for _, p in named), names=[n for n, _ in named])


def sample_optimizer(optim: Any) -> dict[str, Any]:
    params = []
    names: list[str] = []
    try:
        for gi, group in enumerate(getattr(optim, "param_groups", []) or []):
            for pi, p in enumerate(group.get("params") or []):
                params.append(p)
                names.append(f"g{gi}.p{pi}")
    except Exception:
        return {}
    return sample_parameters(params, names=names if _top_k else None)


def emit(step: int | None = None, **extra: Any) -> dict[str, Any]:
    """Emit a ``grads`` metrics event from precomputed fields or empty."""
    from protocol import metrics as aq_metrics

    body = {k: v for k, v in extra.items() if v is not None}
    if step is not None:
        body["step"] = int(step)
    if not body:
        return {}
    aq_metrics.event("grads", **body)
    global _last_step
    if step is not None:
        _last_step = int(step)
    return body


def maybe_from_model(model: Any, step: int | None = None) -> dict[str, Any]:
    if not should_sample(step):
        return {}
    body = sample_model(model)
    if not body:
        return {}
    return emit(step, **body)


def maybe_from_optimizer(optim: Any, step: int | None = None) -> dict[str, Any]:
    if not should_sample(step):
        return {}
    body = sample_optimizer(optim)
    if not body:
        return {}
    # Prefer global step from metrics session when caller omitted it.
    if step is None:
        try:
            from protocol import metrics as aq_metrics

            step = aq_metrics._state.get("step")  # type: ignore[attr-defined]
        except Exception:
            step = None
    return emit(step, **body)


def _short_name(name: str, n: int = 28) -> str:
    s = str(name)
    if len(s) <= n:
        return s
    return "…" + s[-(n - 1) :]


def _vec_norm(t: Any) -> Any:
    import torch

    try:
        return torch.linalg.vector_norm(t)
    except Exception:
        return torch.norm(t)
