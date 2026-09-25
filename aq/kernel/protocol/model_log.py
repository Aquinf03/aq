"""Logged models as first-class: stable IDs linked to checkpoint + dataset.

HF / recipe ``model_id`` is the hub path. aq's stable id is ``aq_model_id`` /
``logged_model`` (content hash of the checkpoint payload + optional weight slot).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from protocol.revision import hash_tree


def _canonical_bytes(model: dict[str, Any]) -> bytes:
    payload = {k: v for k, v in model.items() if k != "aq_model_id"}
    return json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode()


def compute_model_id(model: dict[str, Any], *, weights_dir: Path | None = None) -> str:
    """Content-addressed id for a checkpoint payload (+ optional weight slot)."""
    h = hashlib.sha256()
    h.update(_canonical_bytes(model))
    if weights_dir is not None and weights_dir.is_dir():
        digest, _, _ = hash_tree(weights_dir)
        h.update(b"\0weights\0")
        h.update(digest.encode())
    return "sha256:" + h.hexdigest()


def assign_model_id(model: dict[str, Any], *, weights_dir: Path | None = None) -> str:
    """Hash checkpoint payload (+ optional weight slot) and stamp ``aq_model_id``."""
    mid = compute_model_id(model, weights_dir=weights_dir)
    model["aq_model_id"] = mid
    return mid


def id_from_checkpoint(ckpt: Path) -> str | None:
    """Read ``aq_model_id`` from a checkpoint JSON, or recompute from contents."""
    if not ckpt.is_file():
        return None
    try:
        model = json.loads(ckpt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(model, dict):
        return None
    existing = model.get("aq_model_id")
    if isinstance(existing, str) and existing.startswith("sha256:"):
        return existing
    slot = ckpt.with_suffix("")
    return compute_model_id(model, weights_dir=slot if slot.is_dir() else None)


def model_block(
    *,
    model_id: str,
    checkpoint: str,
    data_hash: str | None = None,
) -> dict[str, Any]:
    """Run-record ``model`` object: id + checkpoint path + dataset hash."""
    out: dict[str, Any] = {
        "id": model_id,
        "checkpoint": checkpoint,
    }
    if data_hash:
        out["data_hash"] = data_hash
    return out
