"""Archaeology: ``runs("Prep")`` → step → try → art over flow folders.

Authoring stays ``class Prep(Flow)`` + ``@step``. This module only *reads*
``artifacts/flow/<Name>/<run_id>/``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from aquin.flow_store import (
    ArtifactStore,
    _safe_name,
    attempt_root,
    done_steps,
    flow_base,
    latest_run_id,
    latest_successful_run_id,
    list_flow_run_ids,
    parse_pathspec,
    pathspec,
    read_steps,
    read_visible_attempt,
)


def runs(flow: str, *, train: str | Path = ".") -> "Runs":
    """Handle for a workflow's executions under the train folder.

    ::

        runs("Prep").latest.art("rows")
        runs("Prep").latest_ok.step("heavy").try_(0).arts
        for run in runs("Prep"):
            print(run.id, run.status)
    """
    return Runs(flow, train=train)


def at(
    spec: str,
    *,
    train: str | Path = ".",
    successful: bool = True,
) -> Any:
    """Resolve a pathspec to ``Runs`` / ``RunView`` / ``StepView`` / ``TryView`` / art value.

    ::

        at("Prep")                         # → Runs
        at("Prep/latest_ok")               # → RunView
        at("Prep/2026…/heavy")             # → StepView
        at("Prep/2026…/heavy/try_0")       # → TryView
        at("Prep/2026…#rows")              # → artifact value
        at("Prep/2026…/heavy/try_0#x")     # → attempt artifact value
    """
    parts = parse_pathspec(spec)
    rs = runs(parts["flow"], train=train)
    run_tok = parts["run"]
    if (
        run_tok is None
        and parts["step"] is None
        and parts["try_n"] is None
        and parts["artifact"] is None
    ):
        return rs

    run_view = _resolve_run(rs, run_tok, successful=successful)

    if parts["step"] is None and parts["try_n"] is None:
        if parts["artifact"]:
            return run_view.art(parts["artifact"])
        return run_view

    step_view = run_view.step(str(parts["step"]))
    if parts["try_n"] is not None:
        try_view = step_view.try_(int(parts["try_n"]))
        if parts["artifact"]:
            return try_view.art(parts["artifact"])
        return try_view

    if parts["artifact"]:
        # step#art → visible run artifact (step is address context)
        return run_view.art(parts["artifact"])
    return step_view


def _resolve_run(rs: "Runs", run_tok: str | None, *, successful: bool) -> "RunView":
    if run_tok is None or run_tok == "latest":
        return rs.latest_ok if successful else rs.latest
    if run_tok == "latest_ok":
        return rs.latest_ok
    return rs[run_tok]


def describe_at(spec: str, *, train: str | Path = ".", successful: bool = True) -> dict[str, Any]:
    """JSON-friendly resolve for CLI — kind + pathspec + optional value."""
    parts = parse_pathspec(spec)
    obj = at(spec, train=train, successful=successful)
    if isinstance(obj, Runs):
        return {
            "kind": "runs",
            "pathspec": parts["flow"],
            "flow": parts["flow"],
            "ids": obj.ids(),
            "n": len(obj),
        }
    if isinstance(obj, RunView):
        return {
            "kind": "run",
            "pathspec": obj.pathspec,
            "flow": obj.flow,
            "run": obj.id,
            "status": obj.status,
            "steps": obj.steps(),
            "arts": list(obj.arts.keys()),
        }
    if isinstance(obj, StepView):
        return {
            "kind": "step",
            "pathspec": obj.pathspec,
            "flow": obj.run.flow,
            "run": obj.run.id,
            "step": obj.name,
            "done": obj.done,
            "tries": obj.tries(),
            "meta": obj.meta,
        }
    if isinstance(obj, TryView):
        return {
            "kind": "try",
            "pathspec": obj.pathspec,
            "flow": obj.step.run.flow,
            "run": obj.step.run.id,
            "step": obj.step.name,
            "try": obj.n,
            "status": obj.status,
            "visible": obj.visible,
            "arts": list(obj.arts.keys()),
            "meta": obj.meta,
        }
    # artifact value
    out: dict[str, Any] = {
        "kind": "art",
        "pathspec": parts["raw"],
        "flow": parts["flow"],
        "run": parts["run"],
        "step": parts["step"],
        "try": parts["try_n"],
        "artifact": parts["artifact"],
        "value": obj,
    }
    # fill run id if latest was resolved
    if parts["artifact"] and (parts["run"] is None or parts["run"] in ("latest", "latest_ok")):
        run_view = _resolve_run(runs(parts["flow"], train=train), parts["run"], successful=successful)
        out["run"] = run_view.id
        out["pathspec"] = pathspec(run_view.flow, run_view.id, artifact=parts["artifact"])
        out["id"] = run_view.art_id(str(parts["artifact"]))
    elif parts["artifact"] and parts["run"] and parts["try_n"] is None:
        run_view = runs(parts["flow"], train=train)[parts["run"]]
        out["id"] = run_view.art_id(str(parts["artifact"]))
        out["pathspec"] = pathspec(run_view.flow, run_view.id, artifact=parts["artifact"])
    return out


class Runs:
    """``artifacts/flow/<Flow>/`` — iterable collection of run views."""

    def __init__(self, flow: str, *, train: str | Path = "."):
        self.flow = flow.strip().split("/")[0]
        self.train = Path(train).expanduser().resolve()

    @property
    def base(self) -> Path:
        return flow_base(self.train, self.flow)

    def ids(self) -> list[str]:
        return list_flow_run_ids(self.train, self.flow)

    def __iter__(self) -> Iterator["RunView"]:
        for rid in self.ids():
            yield RunView(self.train, self.flow, rid)

    def __len__(self) -> int:
        return len(self.ids())

    def __getitem__(self, run_id: str) -> "RunView":
        root = self.base / run_id
        if not root.is_dir():
            raise KeyError(f"no run {run_id!r} for {self.flow} under {self.train}")
        return RunView(self.train, self.flow, run_id)

    def __contains__(self, run_id: object) -> bool:
        return isinstance(run_id, str) and (self.base / run_id).is_dir()

    @property
    def latest(self) -> "RunView":
        """Run pointed at by ``latest`` (may be incomplete)."""
        rid = latest_run_id(self.train, self.flow)
        if not rid:
            raise FileNotFoundError(f"no runs for {self.flow!r} under {self.train}")
        return self[rid]

    @property
    def latest_ok(self) -> "RunView":
        """Newest successful run (``steps.json`` status ``ok``)."""
        rid = latest_successful_run_id(self.train, self.flow)
        if not rid:
            raise FileNotFoundError(f"no successful runs for {self.flow!r} under {self.train}")
        return self[rid]

    def __repr__(self) -> str:
        return f"runs({self.flow!r}, train={str(self.train)!r})"


class RunView:
    """One flow execution — ``artifacts/flow/<Flow>/<run_id>/``."""

    def __init__(self, train: Path, flow: str, run_id: str):
        self.train = Path(train)
        self.flow = flow
        self.id = run_id
        self.root = flow_base(self.train, flow) / run_id

    @property
    def pathspec(self) -> str:
        return pathspec(self.flow, self.id)

    @property
    def status(self) -> str | None:
        st = read_steps(self.root)
        if not st:
            return None
        return str(st.get("status") or "") or None

    @property
    def steps_cursor(self) -> dict[str, Any] | None:
        return read_steps(self.root)

    def steps(self) -> list[str]:
        """Step names with a ``steps/<name>.json`` or ``done/`` marker."""
        names: set[str] = set(done_steps(self.root))
        d = self.root / "steps"
        if d.is_dir():
            for p in d.glob("*.json"):
                names.add(p.stem)
        # preserve done order then alpha for the rest
        done = done_steps(self.root)
        rest = sorted(names - set(done))
        return list(done) + rest

    def __iter__(self) -> Iterator["StepView"]:
        for name in self.steps():
            yield self.step(name)

    def step(self, name: str) -> "StepView":
        return StepView(self, name)

    def art(self, name: str) -> Any:
        """Visible artifact value (run ``artifacts/``)."""
        return ArtifactStore(self.root).get(name)

    @property
    def arts(self) -> dict[str, Any]:
        return ArtifactStore(self.root).load_all()

    def art_id(self, name: str) -> str | None:
        return ArtifactStore(self.root).id_of(name)

    def art_pathspec(self, name: str) -> str:
        return pathspec(self.flow, self.id, artifact=name)

    @property
    def origin(self) -> dict[str, Any] | None:
        from aquin.flow_store import read_origin

        return read_origin(self.root)

    def __repr__(self) -> str:
        return f"RunView({self.pathspec!r}, status={self.status!r})"


class StepView:
    """One ``@step`` in a run — ``done/``, ``steps/<name>.json``, ``attempts/``."""

    def __init__(self, run: RunView, name: str):
        self.run = run
        self.name = name

    @property
    def pathspec(self) -> str:
        return pathspec(self.run.flow, self.run.id, self.name)

    @property
    def done(self) -> bool:
        return (self.run.root / "done" / _safe_name(self.name)).is_file()

    @property
    def meta(self) -> dict[str, Any] | None:
        p = self.run.root / "steps" / f"{_safe_name(self.name)}.json"
        if not p.is_file():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    def tries(self) -> list[int]:
        d = self.run.root / "attempts" / _safe_name(self.name)
        if not d.is_dir():
            return []
        out: list[int] = []
        for p in d.iterdir():
            if p.is_dir() and p.name.isdigit():
                out.append(int(p.name))
        return sorted(out)

    def try_(self, n: int | None = None) -> "TryView":
        """Retry attempt. ``n=None`` → visible (successful) attempt if known."""
        if n is None:
            vis = read_visible_attempt(self.run.root, self.name)
            if vis is None:
                raise FileNotFoundError(
                    f"no visible attempt for {self.pathspec} — pass try_(n) explicitly"
                )
            n = vis
        return TryView(self, int(n))

    def __repr__(self) -> str:
        return f"StepView({self.pathspec!r}, done={self.done})"


class TryView:
    """One retry attempt — ``attempts/<step>/<n>/`` (failed tries stay here)."""

    def __init__(self, step: StepView, n: int):
        self.step = step
        self.n = n
        self.root = attempt_root(step.run.root, step.name, n)

    @property
    def pathspec(self) -> str:
        return f"{self.step.pathspec}/try_{self.n}"

    @property
    def meta(self) -> dict[str, Any] | None:
        p = self.root / "meta.json"
        if not p.is_file():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    @property
    def status(self) -> str | None:
        m = self.meta
        return str(m["status"]) if m and m.get("status") is not None else None

    @property
    def visible(self) -> bool:
        m = self.meta
        return bool(m and m.get("visible"))

    def art(self, name: str) -> Any:
        if not self.root.is_dir():
            raise FileNotFoundError(f"missing attempt dir {self.root}")
        return ArtifactStore(self.root, cas=self.step.run.root / "cas").get(name)

    @property
    def arts(self) -> dict[str, Any]:
        if not self.root.is_dir():
            return {}
        return ArtifactStore(self.root, cas=self.step.run.root / "cas").load_all()

    def __repr__(self) -> str:
        return f"TryView({self.pathspec!r}, status={self.status!r})"
