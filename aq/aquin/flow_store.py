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


def flow_base(train: Path, flow_name: str) -> Path:
    return train / "artifacts" / "flow" / _safe_name(flow_name)


def flow_run_dir(train: Path, flow_name: str, run_id: str | None = None) -> tuple[Path, str]:
    """``artifacts/flow/<FlowName>/<run_id>/`` (+ ``latest`` pointer)."""
    base = flow_base(train, flow_name)
    base.mkdir(parents=True, exist_ok=True)
    rid = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    root = base / rid
    root.mkdir(parents=True, exist_ok=True)
    (base / "latest").write_text(rid + "\n", encoding="utf-8")
    return root, rid


def latest_run_id(train: Path, flow_name: str) -> str | None:
    p = flow_base(train, flow_name) / "latest"
    if not p.is_file():
        return None
    rid = p.read_text(encoding="utf-8").strip()
    return rid or None


def write_step_meta(root: Path, step: str, **extra: Any) -> None:
    d = root / "steps"
    d.mkdir(parents=True, exist_ok=True)
    body = {"step": step, "at": _now(), **extra}
    (d / f"{_safe_name(step)}.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")


def mark_step_done(root: Path, step: str) -> None:
    d = root / "done"
    d.mkdir(parents=True, exist_ok=True)
    (d / _safe_name(step)).write_text(_now() + "\n", encoding="utf-8")


def done_steps(root: Path) -> list[str]:
    d = root / "done"
    if not d.is_dir():
        return []
    return sorted(p.name for p in d.iterdir() if p.is_file())


def is_step_done(root: Path, step: str) -> bool:
    return (root / "done" / _safe_name(step)).is_file()


def write_steps(
    root: Path,
    *,
    status: str,
    step: str | None = None,
    next_step: str | None = None,
    done: list[str] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """Flow ``steps.json`` — which step finished, what’s next, resume status."""
    body: dict[str, Any] = {
        "status": status,
        "at": _now(),
        "step": step,
        "next": next_step,
        "done": done if done is not None else done_steps(root),
    }
    if error:
        body["error"] = error
    (root / "steps.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return body


def read_steps(root: Path) -> dict[str, Any] | None:
    # prefer steps.json; accept earlier names
    for name in ("steps.json", "checkpoint.json", "cursor.json"):
        p = root / name
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return None


def write_boundary_snapshot(
    root: Path,
    *,
    step: str,
    index: int,
    next_step: str | None,
    artifacts: list[str],
    place: str | None = None,
    status: str = "ok",
) -> Path:
    """Freeze observability state at a step boundary (after the step finishes)."""
    snap_dir = root / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    body = {
        "index": index,
        "step": step,
        "next": next_step,
        "status": status,
        "at": _now(),
        "place": place,
        "artifacts": list(artifacts),
        "done": done_steps(root),
    }
    path = snap_dir / f"{index:04d}-{_safe_name(step)}.json"
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    # also keep a rolling latest snapshot pointer
    (snap_dir / "latest.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return path


def resume_entry(root: Path) -> tuple[str | None, list[str]]:
    """Return ``(next_step_to_run, already_done)`` from ``steps.json`` / done markers."""
    done = done_steps(root)
    st = read_steps(root)
    if st:
        status = str(st.get("status") or "")
        if status == "ok" and not st.get("next"):
            return None, done  # finished
        nxt = st.get("next")
        if status in ("failed", "running") and st.get("step") and not is_step_done(root, str(st["step"])):
            # crash mid-step → re-run that step
            return str(st["step"]), [d for d in done if d != st["step"]]
        if nxt:
            return str(nxt), done
    # fall back: if we have done steps, try next.json
    nxt_path = root / "next.json"
    if nxt_path.is_file():
        try:
            data = json.loads(nxt_path.read_text(encoding="utf-8"))
            n = data.get("next")
            if n:
                return str(n), done
        except json.JSONDecodeError:
            pass
    if done:
        # no next recorded — treat as complete
        return None, done
    return "start", []
