"""System metrics — CPU / mem / disk / net / GPU beside train metrics.

Opt-in:

  capture:
    system: true

  aq train --system
  aq eval --system
  AQ_CAPTURE_SYSTEM=1 / AQ_SYSTEM=1

  from aquin import start_system, log_system, stop_system
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.Lock()
_stop = threading.Event()
_thread: threading.Thread | None = None
_interval = 2.0
_last_net: tuple[float, int, int] | None = None  # t, rx, tx


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "on", "1", "system")


def want(rec: dict | None = None, req: dict | None = None) -> bool:
    """req > env > recipe capture.system."""
    if req is not None:
        if "capture_system" in req:
            return _truthy(req.get("capture_system"))
        if "system" in req and req.get("system") is not None:
            return _truthy(req.get("system"))
    for key in ("AQ_CAPTURE_SYSTEM", "AQ_SYSTEM"):
        env = os.environ.get(key, "").strip().lower()
        if env in ("1", "true", "yes", "on"):
            return True
        if env in ("0", "false", "no", "off"):
            return False
    if isinstance(rec, dict):
        raw = rec.get("capture")
        if isinstance(raw, dict) and "system" in raw:
            return _truthy(raw.get("system"))
    return False


def sample() -> dict[str, Any]:
    """Best-effort snapshot. Missing channels are omitted."""
    out: dict[str, Any] = {}
    _sample_cpu_mem(out)
    _sample_disk(out)
    _sample_net(out)
    _sample_gpu(out)
    # Compact strings for TUI / kv display
    if out.get("cpu") is not None:
        out["cpu_s"] = f"{out['cpu']:.0f}%"
    if out.get("mem_used_gb") is not None and out.get("mem_total_gb") is not None:
        out["mem_s"] = f"{out['mem_used_gb']:.1f}/{out['mem_total_gb']:.1f}G"
        if out.get("mem") is not None:
            out["mem_s"] = f"{out['mem']:.0f}% {out['mem_s']}"
    elif out.get("mem") is not None:
        out["mem_s"] = f"{out['mem']:.0f}%"
    if out.get("disk_free_gb") is not None:
        free = out["disk_free_gb"]
        if out.get("disk_used_pct") is not None:
            out["disk_s"] = f"{out['disk_used_pct']:.0f}% used · {free:.0f}G free"
        else:
            out["disk_s"] = f"{free:.0f}G free"
    if out.get("net_rx_mb_s") is not None or out.get("net_tx_mb_s") is not None:
        rx = out.get("net_rx_mb_s") or 0.0
        tx = out.get("net_tx_mb_s") or 0.0
        out["net_s"] = f"↓{rx:.2f} ↑{tx:.2f} MB/s"
    if out.get("gpu_util") is not None or out.get("gpu_mem_used_gb") is not None:
        parts = []
        if out.get("gpu_util") is not None:
            parts.append(f"{out['gpu_util']:.0f}%")
        if out.get("gpu_mem_used_gb") is not None and out.get("gpu_mem_total_gb") is not None:
            parts.append(f"{out['gpu_mem_used_gb']:.1f}/{out['gpu_mem_total_gb']:.1f}G")
        elif out.get("gpu_mem_used_gb") is not None:
            parts.append(f"{out['gpu_mem_used_gb']:.1f}G")
        out["gpu_s"] = " ".join(parts)
        if out.get("gpu_name"):
            out["gpu_s"] = f"{out['gpu_s']} · {out['gpu_name']}"
    return out


def emit_sample() -> dict[str, Any]:
    """Sample once and append a ``system`` metrics event."""
    from protocol import metrics as aq_metrics

    body = sample()
    if not body:
        return body
    # Prefer compact *_s for live UI; keep numeric fields in jsonl.
    aq_metrics.event(
        "system",
        cpu=body.get("cpu"),
        mem=body.get("mem"),
        mem_used_gb=body.get("mem_used_gb"),
        mem_total_gb=body.get("mem_total_gb"),
        disk_free_gb=body.get("disk_free_gb"),
        disk_used_pct=body.get("disk_used_pct"),
        net_rx_mb_s=body.get("net_rx_mb_s"),
        net_tx_mb_s=body.get("net_tx_mb_s"),
        gpu_util=body.get("gpu_util"),
        gpu_mem_used_gb=body.get("gpu_mem_used_gb"),
        gpu_mem_total_gb=body.get("gpu_mem_total_gb"),
        gpu_name=body.get("gpu_name"),
        cpu_s=body.get("cpu_s"),
        mem_s=body.get("mem_s"),
        disk_s=body.get("disk_s"),
        net_s=body.get("net_s"),
        gpu_s=body.get("gpu_s"),
    )
    try:
        from protocol import infra as aq_infra

        aq_infra.maybe_disk(body)
    except Exception:
        pass
    return body


def start(interval: float = 2.0) -> None:
    """Background sampler for the active metrics session."""
    global _thread, _interval
    stop()
    _interval = max(0.5, float(interval))
    _stop.clear()
    emit_sample()

    def _loop() -> None:
        while not _stop.wait(_interval):
            try:
                emit_sample()
            except Exception:
                pass

    t = threading.Thread(target=_loop, name="aq-sysmetrics", daemon=True)
    with _lock:
        _thread = t
    t.start()


def stop() -> None:
    global _thread
    _stop.set()
    with _lock:
        t = _thread
        _thread = None
    if t is not None and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=1.5)


def running() -> bool:
    with _lock:
        return _thread is not None and _thread.is_alive()


# --- collectors -----------------------------------------------------------------


def _sample_cpu_mem(out: dict[str, Any]) -> None:
    try:
        import psutil  # type: ignore

        out["cpu"] = float(psutil.cpu_percent(interval=None))
        vm = psutil.virtual_memory()
        out["mem"] = float(vm.percent)
        out["mem_used_gb"] = round(vm.used / (1024**3), 3)
        out["mem_total_gb"] = round(vm.total / (1024**3), 3)
        return
    except Exception:
        pass
    # stdlib fallbacks
    try:
        load1, _, _ = os.getloadavg()
        n = os.cpu_count() or 1
        out["cpu"] = round(min(100.0, 100.0 * float(load1) / float(n)), 1)
    except (AttributeError, OSError):
        pass
    try:
        # macOS / Linux via page size heuristics is messy; skip mem without psutil
        if Path("/proc/meminfo").is_file():
            info: dict[str, int] = {}
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    info[parts[0][:-1]] = int(parts[1])  # kB
            total = info.get("MemTotal")
            avail = info.get("MemAvailable") or info.get("MemFree")
            if total and avail is not None:
                used = total - avail
                out["mem_total_gb"] = round(total / (1024**2), 3)
                out["mem_used_gb"] = round(used / (1024**2), 3)
                out["mem"] = round(100.0 * used / total, 1)
    except Exception:
        pass


def _sample_disk(out: dict[str, Any]) -> None:
    try:
        u = shutil.disk_usage(str(Path.home()))
        out["disk_free_gb"] = round(u.free / (1024**3), 2)
        if u.total:
            out["disk_used_pct"] = round(100.0 * (u.total - u.free) / u.total, 1)
    except Exception:
        pass


def _sample_net(out: dict[str, Any]) -> None:
    global _last_net
    rx = tx = None
    try:
        import psutil  # type: ignore

        n = psutil.net_io_counters()
        rx, tx = int(n.bytes_recv), int(n.bytes_sent)
    except Exception:
        try:
            # Linux /proc/net/dev totals
            total_rx = total_tx = 0
            for line in Path("/proc/net/dev").read_text(encoding="utf-8").splitlines()[2:]:
                if ":" not in line:
                    continue
                name, rest = line.split(":", 1)
                if name.strip() == "lo":
                    continue
                cols = rest.split()
                if len(cols) >= 9:
                    total_rx += int(cols[0])
                    total_tx += int(cols[8])
            rx, tx = total_rx, total_tx
        except Exception:
            return
    if rx is None or tx is None:
        return
    now = time.monotonic()
    prev = _last_net
    _last_net = (now, rx, tx)
    if prev is None:
        return
    dt = now - prev[0]
    if dt <= 0:
        return
    out["net_rx_mb_s"] = round((rx - prev[1]) / dt / (1024**2), 3)
    out["net_tx_mb_s"] = round((tx - prev[2]) / dt / (1024**2), 3)


def _sample_gpu(out: dict[str, Any]) -> None:
    if _gpu_nvidia_smi(out):
        return
    if _gpu_torch(out):
        return


def _gpu_nvidia_smi(out: dict[str, Any]) -> bool:
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return False
        line = r.stdout.strip().splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return False
        out["gpu_name"] = parts[0][:40]
        try:
            out["gpu_util"] = float(parts[1])
        except ValueError:
            pass
        try:
            out["gpu_mem_used_gb"] = round(float(parts[2]) / 1024.0, 3)
            out["gpu_mem_total_gb"] = round(float(parts[3]) / 1024.0, 3)
        except ValueError:
            pass
        return True
    except Exception:
        return False


def _gpu_torch(out: dict[str, Any]) -> bool:
    try:
        import torch

        if not torch.cuda.is_available():
            return False
        idx = torch.cuda.current_device()
        free, total = torch.cuda.mem_get_info(idx)
        out["gpu_mem_used_gb"] = round((total - free) / (1024**3), 3)
        out["gpu_mem_total_gb"] = round(total / (1024**3), 3)
        props = torch.cuda.get_device_properties(idx)
        out["gpu_name"] = str(getattr(props, "name", f"cuda:{idx}"))[:40]
        return True
    except Exception:
        return False
