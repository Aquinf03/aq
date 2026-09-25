#!/usr/bin/env python3
"""Kernel worker. aq writes artifacts/request.json. This writes artifacts/result.json.

Not a user CLI. One arg: the train directory.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from protocol.revision import hash_train
from protocol.paths import art_dir
from engine.step import do_checkpoint, do_eval, do_serve, do_train
from plot import do_plot


# Keys allowed for non-plot ops (plot passes the full request through).
REQ_KEYS = {
    "op",
    "snapshot",
    "ckpt",
    "keep",
    "probe",
    "prompt",
    "image",
    "max_tokens",
    "temperature",
    "kind",
    "format",
    "dpi",
    "out",
    "out_file",
    "capture_code",
    "capture_env",
    "capture_system",
}


def dispatch(train: Path, req: dict) -> list[str]:
    op = req.get("op")
    if op == "plot":
        # Keep all plot options (fields, charts, layers, script, …).
        return do_plot(train, req)
    req = {k: req[k] for k in REQ_KEYS if k in req}
    if op == "hash":
        return hash_train(train, bool(req.get("snapshot")))
    if op == "train":
        return do_train(train, req)
    if op == "eval":
        return do_eval(train, req.get("ckpt"), req.get("probe"), req)
    if op == "checkpoint":
        return do_checkpoint(train, req.get("keep"))
    if op == "serve":
        mt = req.get("max_tokens")
        temp = req.get("temperature")
        return do_serve(
            train,
            req.get("ckpt"),
            req.get("prompt"),
            int(mt) if mt is not None else None,
            float(temp) if temp is not None else None,
            image=req.get("image"),
        )
    raise SystemExit(f"unknown op: {op}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("kernel: need train dir")
    train = Path(sys.argv[1]).resolve()
    art = art_dir(train)
    art.mkdir(parents=True, exist_ok=True)
    req_path = art / "request.json"
    out_path = art / "result.json"
    if not req_path.is_file():
        raise SystemExit("missing artifacts/request.json")
    req = json.loads(req_path.read_text(encoding="utf-8"))
    try:
        lines = dispatch(train, req)
        out_path.write_text(json.dumps({"ok": True, "lines": lines}, indent=2) + "\n", encoding="utf-8")
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            raise
        msg = str(e.args[0]) if getattr(e, "args", None) else str(e)
        if not msg:
            msg = "kernel failed"
        out_path.write_text(json.dumps({"ok": False, "error": msg}, indent=2) + "\n", encoding="utf-8")
        sys.exit(1)


if __name__ == "__main__":
    main()
