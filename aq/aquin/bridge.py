"""Call the aq kernel (same engine as `aq train`)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from aquin.handle import RunHandle, find_kernel


def _ensure_kernel_path(kernel: Path) -> None:
    s = str(kernel)
    if s not in sys.path:
        sys.path.insert(0, s)


def invoke(handle: RunHandle, op: str, **fields: Any) -> list[str]:
    """
    Run a kernel op against this run.

    Uses the same request/result IPC as the CLI when possible, but calls
    engine steps in-process for a simple SDK path.
    """
    kernel = find_kernel()
    _ensure_kernel_path(kernel)

    # Keep artifacts/request.json for parity with CLI / debugging.
    art = handle.artifacts_dir
    art.mkdir(parents=True, exist_ok=True)
    req = {"op": op, **{k: v for k, v in fields.items() if v is not None}}
    (art / "request.json").write_text(json.dumps(req, indent=2) + "\n", encoding="utf-8")

    train = handle.root
    lines: list[str]
    try:
        if op == "train":
            from engine.step import do_train

            lines = do_train(train)
        elif op == "eval":
            from engine.step import do_eval

            lines = do_eval(train, fields.get("ckpt"), fields.get("probe"))
        elif op == "checkpoint":
            from engine.step import do_checkpoint

            lines = do_checkpoint(train, fields.get("keep"))
        elif op == "serve":
            from engine.step import do_serve

            lines = do_serve(
                train,
                fields.get("ckpt"),
                fields.get("prompt"),
                fields.get("max_tokens"),
                fields.get("temperature"),
                image=fields.get("image"),
            )
        elif op == "hash":
            from protocol.revision import hash_train

            lines = hash_train(train, bool(fields.get("snapshot")))
        else:
            raise ValueError(f"unknown op: {op}")
    except SystemExit as e:
        msg = e.args[0] if e.args else "kernel failed"
        (art / "result.json").write_text(
            json.dumps({"ok": False, "error": str(msg)}, indent=2) + "\n",
            encoding="utf-8",
        )
        raise RuntimeError(str(msg)) from e

    (art / "result.json").write_text(
        json.dumps({"ok": True, "lines": lines}, indent=2) + "\n",
        encoding="utf-8",
    )
    return lines
