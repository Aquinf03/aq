"""Capture step stdout/stderr as timestamped loglines under ``logs/``."""

from __future__ import annotations

import io
import json
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, TextIO


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_name(name: str) -> str:
    out = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    return out or "x"


def step_log_path(run_root: Path, step: str, attempt: int | None = None) -> Path:
    """``logs/<step>.jsonl`` or ``logs/<step>/try_<n>.jsonl``."""
    logs = run_root / "logs"
    if attempt is None:
        return logs / f"{_safe_name(step)}.jsonl"
    return logs / _safe_name(step) / f"try_{int(attempt)}.jsonl"


def text_log_path(run_root: Path, step: str, stream: str, attempt: int | None = None) -> Path:
    logs = run_root / "logs"
    if attempt is None:
        return logs / f"{_safe_name(step)}.{stream}.txt"
    return logs / _safe_name(step) / f"try_{int(attempt)}.{stream}.txt"


class _Tee(TextIO):
    """Write-through to the real stream + line-buffered capture."""

    def __init__(self, original: TextIO, stream: str, on_line: Any):
        self._original = original
        self._stream = stream
        self._on_line = on_line
        self._buf = ""

    def write(self, s: str) -> int:  # type: ignore[override]
        if not isinstance(s, str):
            s = str(s)
        self._original.write(s)
        self._original.flush()
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._on_line(self._stream, line)
        return len(s)

    def flush(self) -> None:
        self._original.flush()

    def finish(self) -> None:
        if self._buf:
            self._on_line(self._stream, self._buf)
            self._buf = ""

    # minimal TextIO surface so libraries don't explode
    @property
    def encoding(self) -> str | None:
        return getattr(self._original, "encoding", "utf-8")

    def fileno(self) -> int:
        return self._original.fileno()

    def isatty(self) -> bool:
        return self._original.isatty()

    def readable(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False


@contextmanager
def capture_step_logs(
    run_root: Path,
    step: str,
    *,
    attempt: int | None = None,
    echo: bool = True,
) -> Iterator[Path]:
    """Tee stdout/stderr into ``logs/…jsonl`` (+ ``.stdout.txt`` / ``.stderr.txt``).

    Yields the jsonl path. ``echo=True`` still prints live (local post-mortem + watch).
    """
    jsonl = step_log_path(run_root, step, attempt)
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    # fresh file per attempt / step run
    jsonl.write_text("", encoding="utf-8")
    out_txt = text_log_path(run_root, step, "stdout", attempt)
    err_txt = text_log_path(run_root, step, "stderr", attempt)
    out_txt.write_text("", encoding="utf-8")
    err_txt.write_text("", encoding="utf-8")

    def on_line(stream: str, line: str) -> None:
        rec = {"at": _now(), "stream": stream, "line": line}
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        target = out_txt if stream == "stdout" else err_txt
        with target.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    old_out, old_err = sys.stdout, sys.stderr
    display_out: TextIO = old_out if echo else io.StringIO()
    display_err: TextIO = old_err if echo else io.StringIO()
    tee_out = _Tee(display_out, "stdout", on_line)
    tee_err = _Tee(display_err, "stderr", on_line)
    sys.stdout = tee_out  # type: ignore[assignment]
    sys.stderr = tee_err  # type: ignore[assignment]
    try:
        yield jsonl
    finally:
        tee_out.finish()
        tee_err.finish()
        sys.stdout = old_out
        sys.stderr = old_err


def promote_attempt_logs(run_root: Path, step: str, attempt: int) -> None:
    """Copy successful attempt logs to the step-level visible paths."""
    src = step_log_path(run_root, step, attempt)
    dest = step_log_path(run_root, step, None)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_file():
        dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    for stream in ("stdout", "stderr"):
        s = text_log_path(run_root, step, stream, attempt)
        d = text_log_path(run_root, step, stream, None)
        if s.is_file():
            d.write_text(s.read_text(encoding="utf-8"), encoding="utf-8")


def read_loglines(
    run_root: Path,
    step: str,
    *,
    attempt: int | None = None,
    stream: str | None = None,
) -> list[dict[str, Any]]:
    """Load timestamped log records. ``stream`` filters ``stdout`` / ``stderr``."""
    path = step_log_path(run_root, step, attempt)
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        if stream and rec.get("stream") != stream:
            continue
        out.append(rec)
    return out


def read_stdout(run_root: Path, step: str, *, attempt: int | None = None) -> str:
    p = text_log_path(run_root, step, "stdout", attempt)
    if p.is_file():
        return p.read_text(encoding="utf-8")
    lines = read_loglines(run_root, step, attempt=attempt, stream="stdout")
    return "\n".join(str(r.get("line") or "") for r in lines) + ("\n" if lines else "")


def read_stderr(run_root: Path, step: str, *, attempt: int | None = None) -> str:
    p = text_log_path(run_root, step, "stderr", attempt)
    if p.is_file():
        return p.read_text(encoding="utf-8")
    lines = read_loglines(run_root, step, attempt=attempt, stream="stderr")
    return "\n".join(str(r.get("line") or "") for r in lines) + ("\n" if lines else "")


def append_raw_log(
    run_root: Path,
    step: str,
    *,
    stream: str,
    text: str,
    attempt: int | None = None,
) -> None:
    """Append a blob (e.g. remote worker failure dump) as loglines."""
    if not text:
        return
    jsonl = step_log_path(run_root, step, attempt)
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    txt = text_log_path(run_root, step, stream, attempt)
    for line in text.splitlines():
        rec = {"at": _now(), "stream": stream, "line": line}
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        with txt.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
