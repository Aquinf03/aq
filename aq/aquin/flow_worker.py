"""Run one Flow step (used locally or on a fleet place).

    python -m aquin.flow_worker --train . --flow-file path.py --class Prep \\
        --step heavy --run-id 2026…
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


def _load_class(flow_file: Path, qualname: str) -> type:
    spec = importlib.util.spec_from_file_location("aq_user_flow", flow_file)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import flow file: {flow_file}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["aq_user_flow"] = mod
    spec.loader.exec_module(mod)
    obj: Any = mod
    for part in qualname.split("."):
        obj = getattr(obj, part)
    if not isinstance(obj, type):
        raise SystemExit(f"{qualname!r} is not a class")
    return obj


def run_step(
    *,
    train: Path,
    flow_file: Path,
    qualname: str,
    step_name: str,
    run_id: str,
) -> dict[str, Any]:
    from aquin.flow import Flow
    from aquin.flow_store import ArtifactStore, write_step_meta

    cls = _load_class(flow_file, qualname)
    if not issubclass(cls, Flow):
        raise SystemExit(f"{qualname} is not a Flow")
    flow = cls()
    name = cls.__name__
    run_root = train / "artifacts" / "flow" / name / run_id
    if not run_root.is_dir():
        raise SystemExit(f"missing flow run dir: {run_root}")
    store = ArtifactStore(run_root)
    object.__setattr__(flow, "_aq_train", train.resolve())
    object.__setattr__(flow, "_aq_run_id", run_id)
    object.__setattr__(flow, "_aq_run_root", run_root)
    object.__setattr__(flow, "_aq_store", store)
    object.__setattr__(flow, "_aq_step_name", step_name)
    object.__setattr__(flow, "_aq_next", None)

    method = getattr(flow, step_name, None)
    if method is None:
        raise SystemExit(f"no step {step_name!r}")
    raw = getattr(method, "__func__", method)
    if not getattr(raw, "_aq_step", False):
        raise SystemExit(f"{step_name!r} is not a @step")

    for k, v in store.load_all().items():
        object.__setattr__(flow, k, v)
    object.__setattr__(flow, "_aq_persist", True)
    try:
        method()
    finally:
        object.__setattr__(flow, "_aq_persist", False)

    nxt = object.__getattribute__(flow, "_aq_next")
    next_name = getattr(nxt, "__name__", None) if nxt else None
    write_step_meta(
        run_root,
        step_name,
        artifacts=store.keys(),
        next=next_name,
        place="worker",
    )
    (run_root / "next.json").write_text(
        json.dumps({"next": next_name}, indent=2) + "\n",
        encoding="utf-8",
    )
    out = {
        "step": step_name,
        "next": next_name,
        "artifacts": store.keys(),
        "path": str(run_root),
    }
    print(json.dumps(out))
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m aquin.flow_worker")
    p.add_argument("--train", required=True)
    p.add_argument("--flow-file", required=True)
    p.add_argument("--class", dest="qualname", required=True)
    p.add_argument("--step", required=True)
    p.add_argument("--run-id", required=True)
    args = p.parse_args(argv)
    run_step(
        train=Path(args.train).expanduser().resolve(),
        flow_file=Path(args.flow_file).expanduser().resolve(),
        qualname=args.qualname,
        step_name=args.step,
        run_id=args.run_id,
    )


if __name__ == "__main__":
    main()
