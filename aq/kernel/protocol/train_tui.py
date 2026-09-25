"""Live train dashboard (TTY) — monitor-style panel + step table.

Falls back to plain append when stderr is not a TTY (CI / pipes).
Disable with AQ_TUI=0.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from typing import Any

from protocol.term_table import fmt_cell

# ANSI
_RESET = "\033[0m"
_DIM = "\033[2m"
_BOLD = "\033[1m"
_GREEN = "\033[32m"
_YELLOW_BG = "\033[48;5;178m\033[30m"  # warm yellow highlight
_HIDE = "\033[?25l"
_SHOW = "\033[?25h"


def enabled() -> bool:
    if os.environ.get("AQ_TUI", "1").strip() in ("0", "false", "no", "off"):
        return False
    try:
        return sys.stderr.isatty()
    except Exception:
        return False


def _term_width() -> int:
    try:
        return max(60, shutil.get_terminal_size(fallback=(100, 24)).columns)
    except Exception:
        return 100


class TrainTui:
    def __init__(self) -> None:
        self.info: dict[str, Any] = {}
        self.latest: dict[str, Any] = {}
        self.steps: list[dict[str, Any]] = []
        self.epochs: list[dict[str, Any]] = []
        self._lines = 0
        self._started = False
        self._last_draw = 0.0
        self.max_rows = 12

    def on_start(self, body: dict[str, Any]) -> None:
        for k in ("op", "method", "family", "run_id"):
            if body.get(k) is not None:
                self.info[k] = body[k]
        self._draw(force=True)

    def on_info(self, body: dict[str, Any]) -> None:
        for k, v in body.items():
            if k in ("ts", "event", "run_id", "op", "elapsed_ms") or v is None:
                continue
            self.info[k] = v
        self._draw(force=True)

    def on_step(self, body: dict[str, Any]) -> None:
        self.latest = dict(body)
        self.steps.append(dict(body))
        if len(self.steps) > 200:
            self.steps = self.steps[-200:]
        self._draw()

    def on_epoch(self, body: dict[str, Any]) -> None:
        self.epochs.append(dict(body))
        self.latest = {**self.latest, **body, "event": "epoch"}
        self._draw(force=True)

    def on_end(self, body: dict[str, Any]) -> None:
        self.latest = {**self.latest, **body, "event": "end"}
        self._draw(force=True)
        self._finish()

    def on_error(self, body: dict[str, Any]) -> None:
        self.info["error"] = body.get("error") or "error"
        self._draw(force=True)
        self._finish()

    def _finish(self) -> None:
        if self._started:
            sys.stderr.write(_SHOW)
            sys.stderr.flush()
            self._started = False
            self._lines = 0

    def _bar(self, frac: float, width: int = 18) -> str:
        frac = max(0.0, min(1.0, float(frac)))
        n = int(round(frac * width))
        filled = "|" * n
        empty = "." * (width - n)
        return f"[{_GREEN}{filled}{_RESET}{_DIM}{empty}{_RESET}]"

    def _progress(self, label: str, cur: Any, total: Any, bar_w: int = 16) -> str:
        try:
            c = float(cur)
            t = float(total) if total not in (None, "", 0) else None
        except (TypeError, ValueError):
            return f"{label}  {fmt_cell(cur)}"
        if t and t > 0:
            return f"{label}  {self._bar(c / t, bar_w)}  {fmt_cell(int(c))}/{fmt_cell(int(t))}"
        return f"{label}  {fmt_cell(cur)}"

    def _kv(self, key: str, val: Any, key_w: int = 8) -> str:
        return f"{_DIM}{key.ljust(key_w)}{_RESET} {fmt_cell(val)}"

    def _system_line(self, info: dict[str, Any], inner: int) -> str | None:
        """One compact row: cpu / mem / disk / net / gpu from system events."""
        bits: list[str] = []
        for key, label in (
            ("cpu_s", "cpu"),
            ("mem_s", "mem"),
            ("disk_s", "disk"),
            ("net_s", "net"),
            ("gpu_s", "gpu"),
        ):
            v = info.get(key)
            if v is None:
                continue
            bits.append(f"{_DIM}{label}{_RESET} {fmt_cell(v)}")
        if not bits:
            return None
        line = "  " + f"  {_DIM}·{_RESET}  ".join(bits)
        if _visible_len(line) > inner + 2:
            return _truncate(line, inner + 2)
        return line

    def _grads_line(self, info: dict[str, Any], lat: dict[str, Any], inner: int) -> str | None:
        """Grad / param norms from grads events (or latest step)."""
        grad_s = info.get("grad_s") or lat.get("grad_s")
        if grad_s is None and info.get("grad_norm") is None and lat.get("grad_norm") is None:
            return None
        if grad_s is None:
            bits = []
            gn = info.get("grad_norm", lat.get("grad_norm"))
            pn = info.get("param_norm", lat.get("param_norm"))
            if gn is not None:
                bits.append(f"‖g‖={fmt_cell(gn)}")
            if pn is not None:
                bits.append(f"‖θ‖={fmt_cell(pn)}")
            top = info.get("grad_top") or lat.get("grad_top")
            if top:
                bits.append(str(top))
            grad_s = " ".join(bits) if bits else None
        if not grad_s:
            return None
        line = f"  {_DIM}grads{_RESET} {fmt_cell(grad_s)}"
        if _visible_len(line) > inner + 2:
            return _truncate(line, inner + 2)
        return line

    def _frame(self) -> list[str]:
        info = self.info
        lat = self.latest
        tw = _term_width()
        # leave a little margin
        inner = tw - 2

        method = info.get("method")
        family = info.get("family")
        title_bits = ["aq train"]
        if method or family:
            title_bits.append(
                f"{fmt_cell(method)}/{fmt_cell(family)}"
                if method and family
                else fmt_cell(method or family)
            )
        if lat.get("elapsed_ms") is not None:
            title_bits.append(f"elapsed {int(lat['elapsed_ms'])}ms")
        lines: list[str] = [f"  {_DIM}{'  ·  '.join(title_bits)}{_RESET}"]

        # columns: progress | train | val/device | run config
        mid = [
            self._kv("loss", lat.get("loss")),
            self._kv("acc", lat.get("acc")),
            self._kv("lr", lat.get("lr")),
        ]
        right = [
            self._kv("val_loss", lat.get("val_loss"), 9),
            self._kv("val_acc", lat.get("val_acc"), 9),
            self._kv("device", info.get("device") or "—", 9),
        ]
        size_v = info.get("image_size")
        if size_v is None:
            size_v = info.get("size")
        has_run = any(info.get(k) is not None for k in ("arch", "classes", "images", "image_size", "size"))
        run = [
            self._kv("arch", info.get("arch")),
            self._kv("classes", info.get("classes")),
            self._kv("images", info.get("images"))
            if size_v is None
            else (
                self._kv("images", info.get("images"))
                if info.get("images") is not None
                else self._kv("size", size_v)
            ),
        ]
        if size_v is not None and info.get("images") is not None:
            run[2] = f"{self._kv('images', info.get('images'))}  {self._kv('size', size_v, 4)}"

        cols_meta = [mid, right] + ([run] if has_run else [])
        n_cols = 1 + len(cols_meta)
        sep_w = 3 * (n_cols - 1)
        usable = max(40, inner - sep_w)
        weights = [3, 2, 2, 3][:n_cols]
        wsum = sum(weights)
        col_ws = [max(16, usable * w // wsum) for w in weights]
        col_ws[-1] += usable - sum(col_ws)

        # size progress bars to fit the progress column (never truncate mid-count)
        # "epoch  [BAR]  12/100" → fixed overhead ≈ 6 + 2 + 2 + 4..7
        left_w = col_ws[0]
        count_room = 9  # "999/9999"
        overhead = 6 + 2 + 2 + count_room  # label + pads + brackets space + counts
        bar_w = max(8, min(24, left_w - overhead))
        left = [
            self._progress("epoch", lat.get("epoch"), info.get("epochs") or lat.get("epochs"), bar_w),
            self._progress("step ", lat.get("step"), lat.get("steps") or info.get("steps"), bar_w),
            "",
        ]
        cols = [left] + cols_meta

        def pad_col(rows: list[str], w: int) -> list[str]:
            out = []
            for r in rows:
                vis = _visible_len(r)
                if vis > w:
                    out.append(_truncate(r, w))
                else:
                    out.append(r + " " * (w - vis))
            while len(out) < 3:
                out.append(" " * w)
            return out

        padded = [pad_col(c, col_ws[i]) for i, c in enumerate(cols)]
        sep = f" {_DIM}|{_RESET} "
        for i in range(3):
            lines.append("  " + sep.join(p[i] for p in padded))

        sys_line = self._system_line(info, inner)
        if sys_line:
            lines.append(sys_line)
        grads_line = self._grads_line(info, lat, inner)
        if grads_line:
            lines.append(grads_line)

        if info.get("error"):
            lines.append(f"  {_BOLD}error  {info['error']}{_RESET}")

        # Step-aligned loss (and lr) curves — live plot in the TUI, not the browser.
        chart_w = max(24, min(inner - 8, 56))
        losses = [
            float(s["loss"])
            for s in self.steps
            if s.get("loss") is not None
            and _finite(s.get("loss"))
        ]
        if losses:
            lines.append("")
            lines.append(f"  {_DIM}loss @ step{_RESET}")
            for row in _step_chart(losses, width=chart_w, height=4):
                lines.append(f"  {_GREEN}{row}{_RESET}")
            lines.append(f"  {_DIM}{fmt_cell(min(losses))}{_RESET}" + " " * max(0, chart_w - 12) + f"{_DIM}{fmt_cell(max(losses))}{_RESET}")
            lines.append(f"  {_DIM}loss  {_RESET}{_GREEN}{_sparkline(losses, chart_w)}{_RESET}")
        lrs = [
            float(s["lr"])
            for s in self.steps
            if s.get("lr") is not None and _finite(s.get("lr"))
        ]
        if lrs and len(lrs) >= 2:
            lines.append(f"  {_DIM}lr    {_RESET}{_sparkline(lrs, chart_w)}")

        # step table — stretch to full inner width
        headers = ["step", "loss", "lr", "acc", "epoch", "time"]
        rows = self.steps[-self.max_rows :]
        grid: list[list[str]] = [headers]
        for s in rows:
            step_n = s.get("step")
            total = s.get("steps") or info.get("steps")
            step_label = (
                f"{step_n}/{total}"
                if total not in (None, "") and step_n is not None
                else fmt_cell(step_n)
            )
            grid.append(
                [
                    step_label,
                    fmt_cell(s.get("loss")),
                    fmt_cell(s.get("lr")),
                    fmt_cell(s.get("acc")),
                    fmt_cell(s.get("epoch")),
                    f"{int(s['elapsed_ms'])}ms" if s.get("elapsed_ms") is not None else "—",
                ]
            )

        n = len(headers)
        min_w = [0] * n
        for row in grid:
            for i, c in enumerate(row):
                min_w[i] = max(min_w[i], len(str(c)))

        # gaps between columns (2 spaces each) + highlight padding (2 spaces inside bg)
        gap = 2
        gaps_total = gap * (n - 1)
        # highlight adds one space each side — account so full row fits inner
        highlight_pad = 2
        budget = max(sum(min_w) + gaps_total, inner - highlight_pad)
        extra = budget - (sum(min_w) + gaps_total)
        widths = list(min_w)
        if extra > 0:
            # spread leftover evenly so the table fills the terminal
            base, rem = divmod(extra, n)
            for i in range(n):
                widths[i] += base + (1 if i < rem else 0)

        def fmt_row(cells: list[str], highlight: bool = False) -> str:
            parts = []
            for i, c in enumerate(cells):
                w = widths[i]
                parts.append(c.rjust(w) if i else c.ljust(w))
            body = (" " * gap).join(parts)
            # pad body to exact budget so highlight spans full table width
            vis = len(body)
            if vis < budget:
                body = body + " " * (budget - vis)
            elif vis > budget:
                body = body[:budget]
            if highlight:
                return f"  {_YELLOW_BG} {body} {_RESET}"
            return f"  {body}"

        lines.append("")
        lines.append(fmt_row(headers))
        rule = (" " * gap).join("─" * w for w in widths)
        if len(rule) < budget:
            rule = rule + "─" * (budget - len(rule))
        lines.append(f"  {_DIM}{rule[:budget]}{_RESET}")
        for i, row in enumerate(grid[1:]):
            hl = i == len(grid) - 2
            lines.append(fmt_row(row, highlight=hl))

        if self.epochs:
            e = self.epochs[-1]
            lines.append(
                f"  {_DIM}epoch {fmt_cell(e.get('epoch'))}  "
                f"loss {fmt_cell(e.get('loss') or e.get('train_loss'))}  "
                f"acc {fmt_cell(e.get('acc') or e.get('train_acc'))}  "
                f"val_acc {fmt_cell(e.get('val_acc'))}{_RESET}"
            )

        if lat.get("event") == "end":
            lines.append(
                f"  {_BOLD}done{_RESET}  "
                f"loss {fmt_cell(lat.get('train_loss') or lat.get('loss'))}  "
                f"acc {fmt_cell(lat.get('train_acc') or lat.get('acc'))}  "
                f"time {fmt_cell(str(int(lat['elapsed_ms'])) + 'ms' if lat.get('elapsed_ms') is not None else None)}"
            )

        return lines

    def _draw(self, force: bool = False) -> None:
        now = time.perf_counter()
        if not force and now - self._last_draw < 0.05:
            return
        self._last_draw = now
        frame = self._frame()
        out = sys.stderr
        if not self._started:
            out.write(_HIDE)
            self._started = True
        elif self._lines > 0:
            out.write(f"\033[{self._lines}A\033[J")
        out.write("\n".join(frame) + "\n")
        out.flush()
        self._lines = len(frame)


def _finite(v: Any) -> bool:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return False
    return x == x and x not in (float("inf"), float("-inf"))


def _sparkline(values: list[float], width: int = 40) -> str:
    if not values:
        return "(no steps)"
    chars = "▁▂▃▄▅▆▇█"
    slice_ = values[-width:] if len(values) > width else values
    lo = min(slice_)
    hi = max(slice_)
    if lo == hi:
        return "▄" * len(slice_)
    out = []
    for v in slice_:
        t = (v - lo) / (hi - lo)
        out.append(chars[max(0, min(len(chars) - 1, int(round(t * (len(chars) - 1)))))])
    return "".join(out)


def _step_chart(values: list[float], *, width: int = 40, height: int = 4) -> list[str]:
    """Multi-row block chart; x = sample index (step-aligned window)."""
    if not values or height < 2 or width < 4:
        return []
    slice_ = values[-width:] if len(values) > width else list(values)
    # resample to width columns
    n = len(slice_)
    cols: list[float] = []
    for i in range(width):
        j = int(i * (n - 1) / max(1, width - 1)) if width > 1 else 0
        cols.append(slice_[min(j, n - 1)])
    lo = min(cols)
    hi = max(cols)
    if lo == hi:
        mid = height // 2
        return [("▄" * width if r == mid else " " * width) for r in range(height)]
    rows: list[list[str]] = [[" " for _ in range(width)] for _ in range(height)]
    for x, v in enumerate(cols):
        t = (v - lo) / (hi - lo)
        y = int(round((1.0 - t) * (height - 1)))
        y = max(0, min(height - 1, y))
        rows[y][x] = "█"
        # light fill under the curve
        for yy in range(y + 1, height):
            if rows[yy][x] == " ":
                rows[yy][x] = "·"
    return ["".join(r) for r in rows]


def _visible_len(s: str) -> int:
    n = 0
    i = 0
    while i < len(s):
        if s[i] == "\033":
            i += 1
            while i < len(s) and s[i] != "m":
                i += 1
            i += 1
            continue
        n += 1
        i += 1
    return n


def _truncate(s: str, w: int) -> str:
    """Truncate to visible width w, preserving ANSI."""
    if _visible_len(s) <= w:
        return s + " " * (w - _visible_len(s))
    out = []
    n = 0
    i = 0
    while i < len(s) and n < w:
        if s[i] == "\033":
            j = i + 1
            while j < len(s) and s[j] != "m":
                j += 1
            out.append(s[i : j + 1])
            i = j + 1
            continue
        out.append(s[i])
        n += 1
        i += 1
    out.append(_RESET)
    return "".join(out)


_tui: TrainTui | None = None


def get() -> TrainTui | None:
    global _tui
    if not enabled():
        return None
    if _tui is None:
        _tui = TrainTui()
    return _tui


def reset() -> None:
    global _tui
    if _tui is not None:
        _tui._finish()
    _tui = None
