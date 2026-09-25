"""Logged tables — ``table(...)`` appends any columns to artifacts/tables/<name>.jsonl.

    from aquin import table
    table(y=1, yhat=0, loss=0.9, note="whatever")   # any fields
    table("preds", id=i, y=y, yhat=yhat)

Browse: ``aq plot table`` · ``aq plot table preds`` · ``aq plot table all``
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol.paths import art_dir

_SAFE = re.compile(r"[^a-zA-Z0-9._-]+")
_DEFAULT = "default"
_ALL = "all"


def tables_dir(train: Path) -> Path:
    d = art_dir(train) / "tables"
    d.mkdir(parents=True, exist_ok=True)
    return d


def table_path(train: Path, name: str = _DEFAULT) -> Path:
    return tables_dir(train) / (safe_name(name) + ".jsonl")


def safe_name(name: str) -> str:
    s = _SAFE.sub("_", str(name or _DEFAULT).strip()) or _DEFAULT
    return s[:80]


def is_all(name: str | None) -> bool:
    return str(name or "").strip().lower() in ("all", "*", "everything")


def list_tables(train: Path) -> list[str]:
    d = art_dir(train) / "tables"
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.glob("*.jsonl") if p.is_file())


def append_row(
    train: Path,
    name: str,
    fields: dict[str, Any],
    *,
    step: int | None = None,
    run_id: str | None = None,
) -> Path:
    """Append one JSONL row. Any JSON-able fields allowed."""
    train = Path(train)
    if is_all(name):
        raise ValueError(
            'table name "all" is reserved for browsing — use table("preds", …) or table(…)'
        )
    clean = {str(k): _jsonable(v) for k, v in fields.items() if v is not None and str(k)}
    if not clean:
        raise ValueError("table() needs at least one field")
    body: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        **clean,
    }
    if step is not None:
        body["step"] = int(step)
    if run_id:
        body["run_id"] = str(run_id)
    path = table_path(train, name)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(body, default=str) + "\n")
    return path


def read_rows(train: Path, name: str = _DEFAULT) -> list[dict[str, Any]]:
    if is_all(name):
        return read_all_rows(train)
    path = table_path(train, name)
    if not path.is_file():
        return []
    return _load_jsonl(path)


def read_all_rows(train: Path) -> list[dict[str, Any]]:
    """Every row from every table, with a ``_table`` column for the source name."""
    out: list[dict[str, Any]] = []
    for name in list_tables(train):
        for row in _load_jsonl(table_path(train, name)):
            body = dict(row)
            body.setdefault("_table", name)
            out.append(body)
    return out


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def columns(rows: list[dict[str, Any]]) -> list[str]:
    """Stable column order: first-seen keys; ``_table`` first when present."""
    prefer = []
    seen = set()
    for r in rows:
        for k in r:
            if k in seen:
                continue
            seen.add(k)
            prefer.append(k)
    tail = [k for k in ("step", "run_id", "ts") if k in seen]
    head = [k for k in prefer if k not in tail and k != "_table"]
    if "_table" in seen:
        return ["_table"] + head + tail
    return head + tail


def resolve_name(train: Path, name: str | None = None) -> str:
    """Pick table name: explicit (incl. all), else sole table, else default."""
    if name and is_all(name):
        return _ALL
    if name:
        return safe_name(name)
    names = list_tables(train)
    if _DEFAULT in names:
        return _DEFAULT
    if len(names) == 1:
        return names[0]
    if names:
        return names[0]
    return _DEFAULT


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, Path):
        return str(v)
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    try:
        import numpy as np

        if isinstance(v, np.generic):
            return v.item()
    except Exception:
        pass
    return str(v)
