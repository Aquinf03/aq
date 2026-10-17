"""Model → run → data lineage (who trained these weights).

Stamps already live on run records (`model`, `data`, `data_hash`). This module
resolves a checkpoint / logged-model id / run id back to that paper trail.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from protocol.model_log import id_from_checkpoint
from protocol.paths import art_dir, ckpt_dir


def _runs_dir(train: Path) -> Path:
    return art_dir(train) / "runs"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _list_runs(train: Path) -> list[tuple[str, Path, dict[str, Any]]]:
    d = _runs_dir(train)
    if not d.is_dir():
        return []
    out: list[tuple[str, Path, dict[str, Any]]] = []
    for p in sorted(d.glob("*.json")):
        if p.name == "last.json":
            continue
        body = _load_json(p)
        if body is None:
            continue
        rid = str(body.get("id") or p.stem)
        out.append((rid, p, body))
    return out


def _run_model_id(run: dict[str, Any]) -> str | None:
    model = run.get("model")
    if isinstance(model, dict):
        mid = model.get("id")
        if isinstance(mid, str) and mid:
            return mid
    arts = run.get("artifacts")
    if isinstance(arts, dict):
        mid = arts.get("logged_model")
        if isinstance(mid, str) and mid:
            return mid
    return None


def _id_match(full: str | None, ref: str) -> bool:
    if not full:
        return False
    if full == ref or full.endswith(ref):
        return True
    # allow sha256: prefix / short hex prefix
    bare = full[7:] if full.startswith("sha256:") else full
    want = ref[7:] if ref.startswith("sha256:") else ref
    return bare == want or bare.startswith(want) or want in bare


def _run_checkpoint(run: dict[str, Any]) -> str | None:
    model = run.get("model")
    if isinstance(model, dict):
        ck = model.get("checkpoint")
        if isinstance(ck, str) and ck:
            return ck
    arts = run.get("artifacts")
    if isinstance(arts, dict):
        for key in ("checkpoint", "checkpoint_last"):
            ck = arts.get(key)
            if isinstance(ck, str) and ck:
                return ck
    return None


def _resolve_checkpoint(train: Path, ref: str) -> Path | None:
    raw = ref.strip()
    ckpts = ckpt_dir(train)
    if raw in ("", "last", "latest"):
        last = ckpts / "last.json"
        return last if last.is_file() else None
    p = Path(raw)
    if not p.is_absolute():
        p = (train / p).resolve()
    if p.is_file():
        return p
    if p.suffix != ".json" and p.with_suffix(".json").is_file():
        return p.with_suffix(".json")
    if raw.isdigit():
        cand = ckpts / f"{raw}.json"
        if cand.is_file():
            return cand
    return None


def _match_run(
    train: Path,
    *,
    model_id: str | None = None,
    checkpoint: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any] | None:
    if run_id:
        body = _load_json(_runs_dir(train) / f"{run_id}.json")
        if body is not None:
            return body
        # allow bare stem / partial
        for rid, _, run in _list_runs(train):
            if rid == run_id or rid.endswith(run_id) or run_id in rid:
                return run
        return None

    matches: list[dict[str, Any]] = []
    for _, _, run in _list_runs(train):
        if model_id:
            if _id_match(_run_model_id(run), model_id):
                matches.append(run)
                continue
        if checkpoint:
            ck = _run_checkpoint(run)
            if not ck:
                continue
            # normalize relative paths
            if ck == checkpoint or ck.endswith(checkpoint) or checkpoint.endswith(ck):
                matches.append(run)
                continue
            try:
                if Path(ck).resolve() == Path(checkpoint).resolve():
                    matches.append(run)
            except OSError:
                pass

    if not matches:
        # fall back to last.json if it matches
        last = _load_json(_runs_dir(train) / "last.json")
        if last is not None:
            if model_id and _id_match(_run_model_id(last), model_id):
                return last
            if checkpoint:
                ck = _run_checkpoint(last)
                if ck and (ck == checkpoint or ck.endswith(Path(checkpoint).name)):
                    return last
        return None

    # prefer newest by `at` then id
    def _key(r: dict[str, Any]) -> str:
        return str(r.get("at") or "") + str(r.get("id") or "")

    matches.sort(key=_key)
    return matches[-1]


def resolve_lineage(
    train: str | Path,
    ref: str | Path = "last",
) -> dict[str, Any]:
    """Resolve ``ref`` to model + run + data.

    ``ref`` may be ``last``, a checkpoint path/step, ``aq_model_id`` (``sha256:…``),
    or a run id.
    """
    root = Path(train).resolve()
    raw = str(ref).strip() if ref is not None else "last"
    if raw in ("", "last", "latest"):
        raw = "last"

    out: dict[str, Any] = {
        "train": str(root),
        "ref": raw,
        "model": None,
        "run": None,
        "data": None,
        "checkpoint": None,
    }

    # 1) explicit run id
    run = _match_run(root, run_id=raw if raw != "last" else None)
    ckpt_path: Path | None = None
    mid: str | None = None

    if run is None:
        ckpt_path = _resolve_checkpoint(root, raw)
        if ckpt_path is not None:
            mid = id_from_checkpoint(ckpt_path)
            try:
                ckpt_rel = str(ckpt_path.relative_to(root))
            except ValueError:
                ckpt_rel = str(ckpt_path)
            run = _match_run(root, model_id=mid, checkpoint=ckpt_rel)
        else:
            # treat as model id (full or suffix)
            run = _match_run(root, model_id=raw)
            if run is not None:
                mid = _run_model_id(run)
                ck = _run_checkpoint(run)
                if ck:
                    cand = root / ck
                    if cand.is_file():
                        ckpt_path = cand

    if run is None and raw == "last":
        run = _load_json(_runs_dir(root) / "last.json")
        if run is not None:
            mid = mid or _run_model_id(run)
            ck = _run_checkpoint(run)
            if ck and ckpt_path is None:
                cand = root / ck
                if cand.is_file():
                    ckpt_path = cand

    if run is None and ckpt_path is None and mid is None:
        raise FileNotFoundError(f"no lineage for {raw!r} under {root}")

    if ckpt_path is None and run is not None:
        ck = _run_checkpoint(run)
        if ck:
            cand = (root / ck).resolve()
            if cand.is_file():
                ckpt_path = cand
                mid = mid or id_from_checkpoint(cand)

    if mid is None and ckpt_path is not None:
        mid = id_from_checkpoint(ckpt_path)

    try:
        ckpt_rel = str(ckpt_path.relative_to(root)) if ckpt_path else None
    except ValueError:
        ckpt_rel = str(ckpt_path) if ckpt_path else None

    dh = None
    if run is not None:
        dh = run.get("data_hash")
        model = run.get("model")
        if isinstance(model, dict) and model.get("data_hash"):
            dh = model.get("data_hash")
        if mid is None:
            mid = _run_model_id(run)

    out["checkpoint"] = ckpt_rel
    out["model"] = {
        "id": mid,
        "checkpoint": ckpt_rel or (run and _run_checkpoint(run)),
        "data_hash": dh,
        "kind": None,
    }
    if ckpt_path is not None:
        payload = _load_json(ckpt_path)
        if payload:
            out["model"]["kind"] = payload.get("kind")

    if run is not None:
        out["run"] = {
            "id": run.get("id"),
            "at": run.get("at"),
            "recipe_hash": run.get("recipe_hash"),
            "data_hash": run.get("data_hash") or dh,
            "pass": run.get("pass"),
            "metrics": run.get("metrics"),
        }
        data = run.get("data")
        if isinstance(data, dict):
            out["data"] = {
                "path": data.get("path"),
                "hash": data.get("hash") or dh,
                "n": data.get("n"),
                "columns": data.get("columns"),
                "target": data.get("target"),
                "kind": data.get("kind"),
                "at": data.get("at"),
            }
        elif dh:
            out["data"] = {"hash": dh}

    if out["data"] is None:
        rev = _load_json(root / "data" / "revision.json")
        if rev is not None:
            out["data"] = {
                "path": rev.get("path"),
                "hash": rev.get("hash") or dh,
                "n": rev.get("n"),
                "columns": rev.get("columns"),
                "target": rev.get("target"),
                "kind": rev.get("kind"),
                "at": rev.get("at"),
            }
        elif dh:
            out["data"] = {"hash": dh}

    return out
