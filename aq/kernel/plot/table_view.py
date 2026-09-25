"""Interactive CLI browser for artifacts/tables/*.jsonl.

Keys: ↑↓/jk scroll · ←→/hl page · / search · s sort · c clear · q quit
"""

from __future__ import annotations

import curses
from typing import Any

from protocol import tables as aq_tables
from pathlib import Path


def browse_table(train: Path, req: dict[str, Any] | None = None) -> list[str]:
    """Open interactive table TUI. Returns summary lines for the kernel result."""
    import sys

    req = req or {}
    raw_name = req.get("table") or req.get("name") or req.get("title")
    name = aq_tables.resolve_name(train, raw_name)
    run_filter = req.get("run") or req.get("run_id")
    rows = aq_tables.read_rows(train, name)
    if run_filter:
        rid = str(run_filter)
        rows = [r for r in rows if str(r.get("run_id") or "") == rid]
    if not rows:
        available = aq_tables.list_tables(train)
        hint = f"known: {', '.join(available)}" if available else "log rows with aquin.table(...)"
        raise SystemExit(f"plot table: no rows for {name!r} ({hint})")

    cols = aq_tables.columns(rows)
    label = "all" if aq_tables.is_all(name) else name
    tty = False
    try:
        tty = sys.stdin.isatty() and sys.stdout.isatty()
    except Exception:
        tty = False
    if not tty:
        return _print_plain(train, label, rows, cols)

    curses.wrapper(lambda stdscr: _ui(stdscr, label, rows, cols))
    if aq_tables.is_all(name):
        n_tables = len(aq_tables.list_tables(train))
        return [f"table all", f"  {n_tables} tables", f"  {len(rows)} rows"]
    path = aq_tables.table_path(train, name)
    try:
        rel = str(path.relative_to(train))
    except ValueError:
        rel = str(path)
    return [f"table {name}", f"  {rel}", f"  {len(rows)} rows"]


def _print_plain(
    train: Path,
    name: str,
    rows: list[dict[str, Any]],
    cols: list[str],
) -> list[str]:
    """Non-TTY fallback: print a simple grid to stdout."""
    widths = {c: max(len(c), *(len(_cell(r.get(c))) for r in rows[:200])) for c in cols}
    for c in cols:
        widths[c] = min(widths[c], 24)
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows[:100]:
        print("  ".join(_cell(r.get(c)).ljust(widths[c])[: widths[c]] for c in cols))
    if len(rows) > 100:
        print(f"… {len(rows) - 100} more (use a TTY for interactive browse)")
    path = aq_tables.table_path(train, name)
    try:
        rel = str(path.relative_to(train))
    except ValueError:
        rel = str(path)
    return [f"table {name}", f"  {rel}", f"  {len(rows)} rows"]


def _cell(v: Any) -> str:
    if v is None:
        return "—"
    s = str(v).replace("\n", " ")
    return s if len(s) <= 40 else s[:39] + "…"


def _ui(stdscr: Any, name: str, rows: list[dict[str, Any]], cols: list[str]) -> None:
    curses.curs_set(0)
    stdscr.keypad(True)
    try:
        curses.use_default_colors()
    except curses.error:
        pass

    filter_q = ""
    sort_i = 0
    sort_asc = True
    offset = 0
    status = ""

    while True:
        h, w = stdscr.getmaxyx()
        view = _filtered(rows, filter_q)
        view = _sorted(view, cols, sort_i, sort_asc)
        page = max(1, h - 4)
        offset = max(0, min(offset, max(0, len(view) - 1)))

        stdscr.erase()
        title = f" aq table · {name} · {len(view)}/{len(rows)} rows "
        if filter_q:
            title += f" · /{filter_q}"
        if cols:
            title += f" · sort {cols[sort_i % len(cols)]}{'↑' if sort_asc else '↓'}"
        _addstr(stdscr, 0, 0, title[: w - 1], curses.A_BOLD)

        widths = _widths(cols, view, w)
        header = _fmt_row(cols, {c: c for c in cols}, widths)
        _addstr(stdscr, 1, 0, header[: w - 1], curses.A_UNDERLINE)

        start = (offset // page) * page
        for i, r in enumerate(view[start : start + page]):
            attr = curses.A_REVERSE if start + i == offset else 0
            line = _fmt_row(cols, r, widths)
            _addstr(stdscr, 2 + i, 0, line[: w - 1], attr)

        help_line = "↑↓ scroll  ←→ page  / find  s sort  c clear  q quit"
        if status:
            help_line = status + "  ·  " + help_line
        _addstr(stdscr, h - 1, 0, help_line[: w - 1], curses.A_DIM)
        stdscr.refresh()

        ch = stdscr.getch()
        status = ""
        if ch in (ord("q"), 27):
            break
        if ch in (curses.KEY_UP, ord("k")):
            offset = max(0, offset - 1)
        elif ch in (curses.KEY_DOWN, ord("j")):
            offset = min(max(0, len(view) - 1), offset + 1)
        elif ch in (curses.KEY_LEFT, ord("h"), curses.KEY_PPAGE):
            offset = max(0, offset - page)
        elif ch in (curses.KEY_RIGHT, ord("l"), curses.KEY_NPAGE):
            offset = min(max(0, len(view) - 1), offset + page)
        elif ch in (curses.KEY_HOME, ord("g")):
            offset = 0
        elif ch in (curses.KEY_END, ord("G")):
            offset = max(0, len(view) - 1)
        elif ch == ord("s"):
            if cols:
                # cycle: asc → desc → next col asc
                if sort_asc:
                    sort_asc = False
                else:
                    sort_asc = True
                    sort_i = (sort_i + 1) % len(cols)
                offset = 0
        elif ch == ord("c"):
            filter_q = ""
            offset = 0
            status = "filter cleared"
        elif ch == ord("/"):
            q = _prompt(stdscr, h - 1, w, "find: ", filter_q)
            if q is not None:
                filter_q = q
                offset = 0
                status = f"filter {filter_q!r}" if filter_q else "filter cleared"
        elif ch == 6:  # Ctrl+F
            q = _prompt(stdscr, h - 1, w, "find: ", filter_q)
            if q is not None:
                filter_q = q
                offset = 0


def _filtered(rows: list[dict[str, Any]], q: str) -> list[dict[str, Any]]:
    if not q:
        return rows
    needle = q.lower()
    out = []
    for r in rows:
        blob = " ".join(str(v) for v in r.values() if v is not None).lower()
        if needle in blob:
            out.append(r)
    return out


def _sorted(
    rows: list[dict[str, Any]],
    cols: list[str],
    sort_i: int,
    asc: bool,
) -> list[dict[str, Any]]:
    if not cols or not rows:
        return rows
    key = cols[sort_i % len(cols)]

    def k(r: dict[str, Any]) -> tuple:
        v = r.get(key)
        if v is None:
            return (1, "")
        if isinstance(v, (int, float)):
            return (0, float(v))
        return (0, str(v).lower())

    return sorted(rows, key=k, reverse=not asc)


def _widths(cols: list[str], rows: list[dict[str, Any]], term_w: int) -> dict[str, int]:
    if not cols:
        return {}
    sample = rows[:80]
    widths = {}
    for c in cols:
        widths[c] = max(len(c), *(len(_cell(r.get(c))) for r in sample)) if sample else len(c)
        widths[c] = min(max(widths[c], 4), 28)
    # shrink to fit
    gap = 2
    total = sum(widths.values()) + gap * (len(cols) - 1)
    budget = max(20, term_w - 2)
    while total > budget and max(widths.values()) > 4:
        c = max(widths, key=lambda x: widths[x])
        widths[c] -= 1
        total -= 1
    return widths


def _fmt_row(cols: list[str], row: dict[str, Any], widths: dict[str, int]) -> str:
    parts = []
    for c in cols:
        w = widths.get(c, 8)
        parts.append(_cell(row.get(c)).ljust(w)[:w])
    return "  ".join(parts)


def _addstr(stdscr: Any, y: int, x: int, s: str, attr: int = 0) -> None:
    try:
        stdscr.addstr(y, x, s, attr)
    except curses.error:
        pass


def _prompt(stdscr: Any, y: int, w: int, label: str, initial: str = "") -> str | None:
    curses.curs_set(1)
    buf = list(initial)
    pos = len(buf)
    while True:
        line = label + "".join(buf)
        _addstr(stdscr, y, 0, " " * (w - 1))
        _addstr(stdscr, y, 0, line[: w - 1])
        try:
            stdscr.move(y, min(len(line), w - 2))
        except curses.error:
            pass
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (10, 13):  # enter
            curses.curs_set(0)
            return "".join(buf)
        if ch == 27:  # esc
            curses.curs_set(0)
            return None
        if ch in (curses.KEY_BACKSPACE, 127, 8):
            if pos > 0:
                pos -= 1
                buf.pop(pos)
        elif 32 <= ch < 127:
            buf.insert(pos, chr(ch))
            pos += 1
