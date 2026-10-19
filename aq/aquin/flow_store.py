"""Persist Flow step attributes under ``artifacts/flow/<name>/<run_id>/``.

Blobs are content-addressed under ``cas/`` (sha256) for dedupe + integrity.
Named files under ``artifacts/`` are small pointers (or legacy raw JSON/pkl).
"""

from __future__ import annotations

import hashlib
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


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _hex(aid: str) -> str:
    s = aid.strip()
    if s.startswith("sha256:"):
        s = s[7:]
    return s


class ArtifactStore:
    """Named artifacts backed by a content-addressed ``cas/`` store."""

    def __init__(self, root: Path):
        self.root = root
        self.dir = root / "artifacts"
        self.cas = root / "cas"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cas.mkdir(parents=True, exist_ok=True)

    def _cas_path(self, aid: str) -> Path:
        h = _hex(aid)
        # shard: ab/cd/<rest> for lighter dirs
        return self.cas / h[:2] / h[2:4] / h

    def _write_cas(self, data: bytes) -> str:
        aid = _sha256_bytes(data)
        path = self._cas_path(aid)
        if path.is_file():
            # dedupe — already stored
            return aid
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return aid

    def _read_cas(self, aid: str) -> bytes:
        path = self._cas_path(aid)
        if not path.is_file():
            raise FileNotFoundError(f"missing cas blob {aid}")
        return path.read_bytes()

    def put(self, name: str, value: Any) -> Path:
        """Store ``value`` by content hash; name points at the sha."""
        key = _safe_name(name)
        fmt = "json"
        try:
            data = (json.dumps(value, indent=2) + "\n").encode("utf-8")
        except TypeError:
            fmt = "pkl"
            data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)

        aid = self._write_cas(data)
        pointer = {"aq_cas": aid, "format": fmt, "at": _now()}
        # clear legacy raw siblings
        for suffix in (".json", ".pkl"):
            legacy = self.dir / f"{key}{suffix}"
            # only remove if it's not our pointer file we'll overwrite
            if suffix == ".pkl" and legacy.is_file():
                legacy.unlink()
            if suffix == ".json" and legacy.is_file():
                try:
                    old = json.loads(legacy.read_text(encoding="utf-8"))
                    if not (isinstance(old, dict) and "aq_cas" in old):
                        pass  # overwrite below
                except Exception:
                    pass
        ptr_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"
        if pkl_path.is_file():
            pkl_path.unlink()
        ptr_path.write_text(json.dumps(pointer, indent=2) + "\n", encoding="utf-8")
        self._update_index(key, aid, fmt)
        return ptr_path

    def _update_index(self, name: str, aid: str, fmt: str) -> None:
        idx_path = self.root / "cas_index.json"
        idx: dict[str, Any] = {}
        if idx_path.is_file():
            try:
                raw = json.loads(idx_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    idx = raw
            except json.JSONDecodeError:
                idx = {}
        idx[name] = {"id": aid, "format": fmt, "at": _now()}
        idx_path.write_text(json.dumps(idx, indent=2) + "\n", encoding="utf-8")

    def id_of(self, name: str) -> str | None:
        """Content id for a named artifact, if known."""
        key = _safe_name(name)
        ptr = self.dir / f"{key}.json"
        if ptr.is_file():
            try:
                body = json.loads(ptr.read_text(encoding="utf-8"))
                if isinstance(body, dict) and body.get("aq_cas"):
                    return str(body["aq_cas"])
            except json.JSONDecodeError:
                pass
        idx_path = self.root / "cas_index.json"
        if idx_path.is_file():
            try:
                idx = json.loads(idx_path.read_text(encoding="utf-8"))
                ent = idx.get(key) if isinstance(idx, dict) else None
                if isinstance(ent, dict) and ent.get("id"):
                    return str(ent["id"])
            except json.JSONDecodeError:
                pass
        return None

    def ids(self) -> dict[str, str]:
        """name → sha256 id."""
        out: dict[str, str] = {}
        for k in self.keys():
            aid = self.id_of(k)
            if aid:
                out[k] = aid
        return out

    def get(self, name: str) -> Any:
        key = _safe_name(name)
        json_path = self.dir / f"{key}.json"
        pkl_path = self.dir / f"{key}.pkl"

        if json_path.is_file():
            try:
                body = json.loads(json_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict) and body.get("aq_cas"):
                raw = self._read_cas(str(body["aq_cas"]))
                fmt = str(body.get("format") or "json")
                if fmt == "pkl":
                    return pickle.loads(raw)
                return json.loads(raw.decode("utf-8"))
            # legacy: raw JSON value
            if body is not None:
                return body

        if pkl_path.is_file():
            with pkl_path.open("rb") as f:
                return pickle.load(f)
        raise KeyError(name)

    def load_all(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k in self.keys():
            try:
                out[k] = self.get(k)
            except Exception:
                continue
        return out

    def keys(self) -> list[str]:
        if not self.dir.is_dir():
            return []
        names: set[str] = set()
        for p in self.dir.iterdir():
            if p.suffix in (".json", ".pkl"):
                names.add(p.stem)
        return sorted(names)

    def verify(self) -> dict[str, Any]:
        """Re-hash every CAS blob + check pointers. Returns report."""
        ok: list[str] = []
        bad: list[dict[str, str]] = []
        missing: list[str] = []

        # verify all cas files
        if self.cas.is_dir():
            for p in self.cas.rglob("*"):
                if not p.is_file() or p.suffix == ".tmp":
                    continue
                data = p.read_bytes()
                got = _sha256_bytes(data)
                expect = "sha256:" + p.name
                if got != expect:
                    bad.append({"path": str(p.relative_to(self.root)), "expected": expect, "got": got})
                else:
                    ok.append(got)

        # verify named pointers resolve
        for name in self.keys():
            aid = self.id_of(name)
            if not aid:
                # legacy raw file — hash it for reporting
                continue
            path = self._cas_path(aid)
            if not path.is_file():
                missing.append(f"{name} → {aid}")
                continue
            data = path.read_bytes()
            got = _sha256_bytes(data)
            if got != aid:
                bad.append({"name": name, "expected": aid, "got": got})

        return {
            "ok": len(ok),
            "bad": bad,
            "missing": missing,
            "ids": self.ids(),
            "pass": not bad and not missing,
        }


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
    artifact_ids: dict[str, str] | None = None,
) -> Path:
    """Freeze observability state at a step boundary (after the step finishes)."""
    snap_dir = root / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    body: dict[str, Any] = {
        "index": index,
        "step": step,
        "next": next_step,
        "status": status,
        "at": _now(),
        "place": place,
        "artifacts": list(artifacts),
        "done": done_steps(root),
    }
    if artifact_ids:
        body["artifact_ids"] = artifact_ids
    path = snap_dir / f"{index:04d}-{_safe_name(step)}.json"
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
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
            return str(st["step"]), [d for d in done if d != st["step"]]
        if nxt:
            return str(nxt), done
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
        return None, done
    return "start", []
