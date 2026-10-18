"""Persist Flow step attributes under ``artifacts/flow/<name>/<run_id>/``."""

from __future__ import annotations

import json
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_name(name: str) -> str:
    out = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    return out or "x"


class ArtifactStore:
    """Folder store: each ``self.x = …`` lands as ``artifacts/<name>.json`` or ``.pkl``."""

    def __init__(self, root: Path):
        self.root = root
        self.dir = root / "artifacts"
        self.dir.mkdir(parents=True, exist_ok=True)

    def put(self, name: str, value: Any) -> Path:
        key = _safe_name(name)
        json_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"
        # prefer JSON when possible
        try:
            raw = json.dumps(value, indent=2)
        except TypeError:
            if json_path.is_file():
                json_path.unlink()
            with pkl_path.open("wb") as f:
                pickle.dump(value, f, protocol=pickle.HIGHEST_PROTOCOL)
            return pkl_path
        if pkl_path.is_file():
            pkl_path.unlink()
        json_path.write_text(raw + "\n", encoding="utf-8")
        return json_path

    def get(self, name: str) -> Any:
        key = _safe_name(name)
        json_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"
        if json_path.is_file():
            return json.loads(json_path.read_text(encoding="utf-8"))
        if pkl_path.is_file():
            with pkl_path.open("rb") as f:
                return pickle.load(f)
        raise KeyError(name)

    def load_all(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if not self.dir.is_dir():
            return out
        seen: set[str] = set()
        for p in sorted(self.dir.iterdir()):
            if p.suffix == ".json":
                key = p.stem
                if key in seen:
                    continue
                out[key] = json.loads(p.read_text(encoding="utf-8"))
                seen.add(key)
            elif p.suffix == ".pkl":
                key = p.stem
                if key in seen:
                    continue
                with p.open("rb") as f:
                    out[key] = pickle.load(f)
                seen.add(key)
        return out

    def keys(self) -> list[str]:
        return sorted(self.load_all().keys())


def flow_run_dir(train: Path, flow_name: str, run_id: str | None = None) -> tuple[Path, str]:
    """``artifacts/flow/<FlowName>/<run_id>/`` (+ ``latest`` pointer)."""
    base = train / "artifacts" / "flow" / _safe_name(flow_name)
    base.mkdir(parents=True, exist_ok=True)
    rid = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    root = base / rid
    root.mkdir(parents=True, exist_ok=True)
    (base / "latest").write_text(rid + "\n", encoding="utf-8")
    return root, rid


def write_step_meta(root: Path, step: str, **extra: Any) -> None:
    d = root / "steps"
    d.mkdir(parents=True, exist_ok=True)
    body = {"step": step, "at": _now(), **extra}
    (d / f"{_safe_name(step)}.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
