"""Live eval scoreboard (TTY) — distinct from the train monitor.

Disable with AQ_TUI=0 (same flag as train).
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from typing import Any

from protocol.term_table import fmt_cell

_RESET = "\033[0m"
_DIM = "\033[2m"
_BOLD = "\033[1m"
_GREEN = "\033[32m"
_RED = "\033[31m"
_YELLOW = "\033[33m"
_YELLOW_BG = "\033[48;5;178m\033[30m"
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
        return max(56, shutil.get_terminal_size(fallback=(100, 24)).columns)
    except Exception:
        return 100


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


class EvalTui:
    """Scoreboard: metric/score/verdict + probe table. No train bars."""

    def __init__(self) -> None:
        self.info: dict[str, Any] = {}
        self.probes: list[dict[str, Any]] = []
        self.latest: dict[str, Any] = {}
        self._lines = 0
        self._started = False
        self._last_draw = 0.0

    def on_start(self, body: dict[str, Any]) -> None:
        for k in ("op", "method", "family", "checkpoint", "min_score", "run_id"):
            if body.get(k) is not None:
                self.info[k] = body[k]
        self._draw(force=True)

    def on_info(self, body: dict[str, Any]) -> None:
        for k, v in body.items():
            if k in ("ts", "event", "run_id", "op", "elapsed_ms") or v is None:
                continue
            self.info[k] = v
        self._draw(force=True)

    def on_probe(self, body: dict[str, Any]) -> None:
        self.probes.append(dict(body))
        self.latest = dict(body)
        self._draw(force=True)

    def on_end(self, body: dict[str, Any]) -> None:
        self.latest = {**self.latest, **body, "event": "end"}
        for k in ("metric", "score", "n", "pass", "min_score"):
            if body.get(k) is not None:
                self.info[k] = body[k]
        if body.get("verdict") is not None:
            self.info["verdict"] = body["verdict"]
        elif body.get("pass") is True:
            self.info["verdict"] = "pass"
        elif body.get("pass") is False:
            self.info["verdict"] = "fail"
        elif self.info.get("min_score") is None:
            self.info["verdict"] = "skip"
        self._draw(force=True)
        self._finish()

    def on_error(self, body: dict[str, Any]) -> None:
        self.info["error"] = body.get("error") or body.get("message") or "error"
        self._draw(force=True)
        self._finish()

    def _finish(self) -> None:
        if self._started:
            sys.stderr.write(_SHOW)
            sys.stderr.flush()
            self._started = False
            self._lines = 0

    def _verdict_str(self) -> str:
        v = self.info.get("verdict")
        if v is None and self.latest.get("event") != "end":
            return "—"
        if self.info.get("pass") is True or v == "pass":
            return f"{_GREEN}{_BOLD}pass{_RESET}"
        if self.info.get("pass") is False or v == "fail":
            return f"{_RED}{_BOLD}fail{_RESET}"
        return f"{_DIM}skip{_RESET}"

    def _color_result(self, s: str) -> str:
        if s == "pass":
            return f"{_GREEN}{s}{_RESET}"
        if s == "fail":
            return f"{_RED}{s}{_RESET}"
        return f"{_DIM}{s}{_RESET}"

    def _frame(self) -> list[str]:
        info = self.info
        lat = self.latest
        tw = _term_width()
        inner = tw - 2

        title_bits = ["aq eval"]
        if info.get("method"):
            title_bits.append(fmt_cell(info["method"]))
        if info.get("family"):
            title_bits.append(fmt_cell(info["family"]))
        if lat.get("elapsed_ms") is not None:
            title_bits.append(f"{int(lat['elapsed_ms'])}ms")
        lines: list[str] = [f"  {_DIM}{'  ·  '.join(title_bits)}{_RESET}"]

        metric = info.get("metric")
        if metric is None and self.probes:
            metric = self.probes[-1].get("metric")
        score = info.get("score")
        if score is None and self.probes:
            score = self.probes[-1].get("score")
        n = info.get("n")
        if n is None and self.probes:
            n = sum(int(p.get("n") or 0) for p in self.probes)

        left = [
            f"{_DIM}metric{_RESET}   {fmt_cell(metric)}",
            f"{_DIM}score{_RESET}    {_BOLD}{fmt_cell(score)}{_RESET}",
            f"{_DIM}samples{_RESET}  {fmt_cell(n)}",
        ]
        ckpt = fmt_cell(info.get("checkpoint") or "—")
        if len(ckpt) > 36:
            ckpt = "…" + ckpt[-35:]
        right = [
            f"{_DIM}verdict{_RESET}  {self._verdict_str()}",
            f"{_DIM}min{_RESET}      {fmt_cell(info.get('min_score'))}",
            f"{_DIM}ckpt{_RESET}     {ckpt}",
        ]
        sep_w = 3
        usable = max(40, inner - sep_w)
        lw, rw = usable // 2, usable - usable // 2

        def pad(rows: list[str], w: int) -> list[str]:
            out = []
            for r in rows:
                vis = _visible_len(r)
                out.append(r + " " * max(0, w - vis) if vis <= w else r)
            while len(out) < 3:
                out.append(" " * w)
            return out

        L, R = pad(left, lw), pad(right, rw)
        for i in range(3):
            lines.append(f"  {L[i]} {_DIM}|{_RESET} {R[i]}")

        bits: list[str] = []
        for key, label in (
            ("cpu_s", "cpu"),
            ("mem_s", "mem"),
            ("disk_s", "disk"),
            ("net_s", "net"),
            ("gpu_s", "gpu"),
        ):
            v = info.get(key)
            if v is not None:
                bits.append(f"{_DIM}{label}{_RESET} {fmt_cell(v)}")
        if bits:
            sys_line = "  " + f"  {_DIM}·{_RESET}  ".join(bits)
            if _visible_len(sys_line) > inner + 2:
                # soft truncate
                sys_line = sys_line[: inner + 2]
            lines.append(sys_line)

        infra = info.get("infra_s")
        if infra:
            line = f"  {_YELLOW}infra{_RESET} {fmt_cell(infra)}"
            if _visible_len(line) > inner + 2:
                line = line[: inner + 2]
            lines.append(line)

        if info.get("error"):
            lines.append(f"  {_BOLD}{_RED}error{_RESET}  {info['error']}")

        headers = ["probe", "metric", "score", "n", "result"]
        grid: list[list[str]] = [headers]
        for p in self.probes:
            fp = p.get("pass")
            grid.append(
                [
                    str(p.get("path") or "probe"),
                    fmt_cell(p.get("metric")),
                    fmt_cell(p.get("score")),
                    fmt_cell(p.get("n")),
                    "pass" if fp is True else "fail" if fp is False else "—",
                ]
            )

        n_cols = len(headers)
        min_w = [0] * n_cols
        for row in grid:
            for i, c in enumerate(row):
                min_w[i] = max(min_w[i], len(str(c)))
        gap = 2
        gaps_total = gap * (n_cols - 1)
        budget = max(sum(min_w) + gaps_total, inner - 2)
        extra = budget - (sum(min_w) + gaps_total)
        widths = list(min_w)
        if extra > 0:
            widths[0] += extra

        def fmt_row(cells: list[str], *, highlight: bool, header: bool) -> str:
            plain_parts = []
            fancy_parts = []
            for i, c in enumerate(cells):
                w = widths[i]
                text = c
                if i == 0 and len(text) > w:
                    text = "…" + text[-(w - 1) :]
                aligned = text.ljust(w) if i == 0 else text.rjust(w)
                plain_parts.append(aligned)
                if not header and i == n_cols - 1:
                    pad_n = w - len(text)
                    fancy_parts.append((" " * pad_n) + self._color_result(text))
                else:
                    fancy_parts.append(aligned)
            plain = (" " * gap).join(plain_parts)
            if len(plain) < budget:
                plain = plain + " " * (budget - len(plain))
            if highlight:
                return f"  {_YELLOW_BG} {plain[:budget]} {_RESET}"
            body = (" " * gap).join(fancy_parts)
            vis = _visible_len(body)
            if vis < budget:
                body = body + " " * (budget - vis)
            return f"  {body}"

        lines.append("")
        lines.append(fmt_row(headers, highlight=False, header=True))
        rule = (" " * gap).join("─" * w for w in widths)
        if len(rule) < budget:
            rule = rule + "─" * (budget - len(rule))
        lines.append(f"  {_DIM}{rule[:budget]}{_RESET}")
        for i, row in enumerate(grid[1:]):
            lines.append(fmt_row(row, highlight=(i == len(grid) - 2), header=False))

        if lat.get("event") == "end":
            lines.append(
                f"  {_BOLD}done{_RESET}  {fmt_cell(metric)} {fmt_cell(info.get('score'))}  "
                f"{self._verdict_str()}  "
                f"{fmt_cell(str(int(lat['elapsed_ms'])) + 'ms' if lat.get('elapsed_ms') is not None else None)}"
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


_tui: EvalTui | None = None


def get() -> EvalTui | None:
    global _tui
    if not enabled():
        return None
    if _tui is None:
        _tui = EvalTui()
    return _tui


def reset() -> None:
    global _tui
    if _tui is not None:
        _tui._finish()
    _tui = None
