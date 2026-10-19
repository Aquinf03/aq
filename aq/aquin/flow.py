"""SDK-authored runs + multi-step Flow with auto-persisted ``self.x``.

``Run`` — class attrs → recipe.yaml path map.

``Flow`` — Metaflow-shaped steps; assigning ``self.x`` writes an artifact so the
next step can read it with no manual save/load. Steps may run on a fleet place
(``@step(place=\"gpu\")``) — sync / pull is automatic.
"""

from __future__ import annotations

import inspect
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from aquin.client import Aquin
from aquin.flow_store import (
    ArtifactStore,
    done_steps,
    flow_run_dir,
    is_step_done,
    latest_run_id,
    mark_step_done,
    read_cursor,
    resume_entry,
    write_boundary_snapshot,
    write_cursor,
    write_step_meta,
)


def step(fn: Callable[..., Any] | None = None, *, place: str | None = None):
    """Mark a Flow method as a step.

    ``place`` — SSH place name from ``aq add`` / ``Place``. When set, the step
    runs on that box; train folder sync + artifact pull are automatic.
    """

    def deco(f: Callable[..., Any]) -> Callable[..., Any]:
        setattr(f, "_aq_step", True)
        setattr(f, "_aq_place", place)
        return f

    if fn is not None:
        return deco(fn)
    return deco


class Run:
    """
    Class-as-run (Metaflow-shaped). Class attrs become the path map; YAML is written on create.

        class Ridge(Run):
            family = "tabular"
            method = "ridge"
            data = {"path": "data.csv", "target": "y"}
            eval = {"metric": "mse", "min_score": 1.0}

        aq = Ridge.create(".")
        aq.train()
    """

    family: str
    method: str
    data: dict[str, Any]
    eval: dict[str, Any]  # type: ignore[assignment]

    @classmethod
    def recipe_dict(cls) -> dict[str, Any]:
        skip = {
            "recipe_dict",
            "create",
            "open",
            "to_dict",
        }
        data: dict[str, Any] = {}
        for base in reversed(cls.__mro__):
            if base is object or base is Run:
                continue
            for k, v in vars(base).items():
                if k.startswith("_") or k in skip:
                    continue
                if callable(v) and not isinstance(v, (type, staticmethod, classmethod)):
                    continue
                if isinstance(v, (classmethod, staticmethod)):
                    continue
                data[k] = v
        return data

    @classmethod
    def create(
        cls,
        dest: str | Path = ".",
        *,
        config_path: str | Path | None = None,
        artifacts: str | Path | None = None,
    ) -> Aquin:
        """Materialize recipe.yaml (path map) + return an Aquin client."""
        root = Path(dest).expanduser().resolve()
        if root.suffix in (".yaml", ".yml"):
            cfg = root
            art = artifacts
        else:
            root.mkdir(parents=True, exist_ok=True)
            cfg = Path(config_path).expanduser().resolve() if config_path else (root / "recipe.yaml")
            art = artifacts
        return Aquin.define(cls.recipe_dict(), config_path=cfg, artifacts=art)


def _step_place(fn: Callable[..., Any]) -> str | None:
    raw = getattr(fn, "__func__", fn)
    place = getattr(raw, "_aq_place", None)
    return str(place) if place else None


def _resolve_flow_file(cls: type, train: Path, run_root: Path) -> Path:
    """Copy the .py defining the Flow into the run dir (for worker / remote import)."""
    try:
        src = Path(inspect.getfile(cls)).resolve()
    except TypeError as e:
        raise TypeError(
            f"cannot locate source file for {cls.__name__} — define the Flow in a .py file "
            f"(needed for @step(place=…))"
        ) from e
    if not src.is_file() or src.name.startswith("<"):
        raise TypeError(
            f"cannot locate source file for {cls.__name__} — define the Flow in a .py file "
            f"(needed for @step(place=…))"
        )
    dest = run_root / "flow_src.py"
    shutil.copy2(src, dest)
    return dest


def _read_next(run_root: Path, step_name: str) -> str | None:
    nxt_path = run_root / "next.json"
    if nxt_path.is_file():
        try:
            data = json.loads(nxt_path.read_text(encoding="utf-8"))
            n = data.get("next")
            return str(n) if n else None
        except json.JSONDecodeError:
            pass
    meta = run_root / "steps" / f"{step_name}.json"
    if meta.is_file():
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            n = data.get("next")
            return str(n) if n else None
        except json.JSONDecodeError:
            pass
    return None


class Flow:
    """Multi-step flow: ``self.x = …`` persists between steps under ``artifacts/flow/``.

    Local and remote steps use the same artifact paths — fleet sync/pull is the
    transfer glue (you don't write it).

        from aquin import Flow, step

        class Prep(Flow):
            @step
            def start(self):
                self.rows = [[1.0, 2.0]]
                self.next(self.heavy)

            @step(place="gpu")   # optional: run on an SSH place
            def heavy(self):
                self.rows = self.rows + [[3.0, 4.0]]
                self.next(self.end)

            @step
            def end(self):
                print(self.rows)

        Prep().run(".")
        Prep().run(".", resume=True)   # continue after crash from cursor
    """

    _AQ_INTERNAL = frozenset(
        {
            "next",
            "run",
            "artifacts",
            "train",
            "run_id",
            "step_name",
            "place",
        }
    )

    def __init__(self) -> None:
        object.__setattr__(self, "_aq_persist", False)
        object.__setattr__(self, "_aq_store", None)
        object.__setattr__(self, "_aq_next", None)
        object.__setattr__(self, "_aq_train", None)
        object.__setattr__(self, "_aq_run_id", None)
        object.__setattr__(self, "_aq_run_root", None)
        object.__setattr__(self, "_aq_step_name", None)
        object.__setattr__(self, "_aq_flow_file", None)
        object.__setattr__(self, "_aq_default_place", None)

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_aq_") or name.startswith("__"):
            object.__setattr__(self, name, value)
            return
        if name in self._AQ_INTERNAL and not object.__getattribute__(self, "_aq_persist"):
            object.__setattr__(self, name, value)
            return
        object.__setattr__(self, name, value)
        if object.__getattribute__(self, "_aq_persist"):
            store = object.__getattribute__(self, "_aq_store")
            if store is not None and not callable(value):
                store.put(name, value)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            raise AttributeError(name)
        try:
            val = store.get(name)
        except KeyError as e:
            raise AttributeError(name) from e
        object.__setattr__(self, name, val)
        return val

    def next(self, destination: Callable[..., Any]) -> None:
        """Transition to another ``@step`` when this step returns."""
        if not callable(destination):
            raise TypeError("next() expects a step method, e.g. self.next(self.end)")
        fn = destination
        raw = getattr(fn, "__func__", fn)
        if not getattr(raw, "_aq_step", False):
            raise TypeError(f"{getattr(fn, '__name__', fn)!r} is not a @step")
        object.__setattr__(self, "_aq_next", fn)

    @property
    def train(self) -> Path | None:
        return object.__getattribute__(self, "_aq_train")

    @property
    def run_id(self) -> str | None:
        return object.__getattribute__(self, "_aq_run_id")

    @property
    def step_name(self) -> str | None:
        return object.__getattribute__(self, "_aq_step_name")

    @property
    def place(self) -> str | None:
        """Place the *current* step is running on (if remote)."""
        return None  # set only inside remote worker context via env if needed

    def artifacts(self) -> dict[str, Any]:
        """All persisted ``self.*`` values for this flow run."""
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            return {}
        return store.load_all()

    def _boundary(
        self,
        run_root: Path,
        store: ArtifactStore,
        *,
        step_name: str,
        next_name: str | None,
        index: int,
        place: str | None,
        status: str = "ok",
    ) -> None:
        """Snapshot + done marker + cursor after a step boundary."""
        write_step_meta(
            run_root,
            step_name,
            artifacts=store.keys(),
            next=next_name,
            place=place,
            status=status,
        )
        (run_root / "next.json").write_text(
            json.dumps({"next": next_name}, indent=2) + "\n",
            encoding="utf-8",
        )
        if status == "ok":
            mark_step_done(run_root, step_name)
        write_boundary_snapshot(
            run_root,
            step=step_name,
            index=index,
            next_step=next_name,
            artifacts=store.keys(),
            place=place,
            status=status,
        )
        write_cursor(
            run_root,
            status="ok" if next_name is None and status == "ok" else ("failed" if status != "ok" else "running"),
            step=step_name,
            next_step=next_name,
            done=done_steps(run_root),
        )

    def _run_step_local(
        self,
        method: Callable[..., Any],
        store: ArtifactStore,
        run_root: Path,
        step_name: str,
        *,
        index: int,
    ) -> str | None:
        object.__setattr__(self, "_aq_next", None)
        for k, v in store.load_all().items():
            object.__setattr__(self, k, v)
        write_cursor(
            run_root,
            status="running",
            step=step_name,
            next_step=None,
            done=done_steps(run_root),
        )
        object.__setattr__(self, "_aq_persist", True)
        try:
            method()
        except Exception as e:
            object.__setattr__(self, "_aq_persist", False)
            write_cursor(
                run_root,
                status="failed",
                step=step_name,
                next_step=step_name,
                done=done_steps(run_root),
                error=f"{type(e).__name__}: {e}",
            )
            write_boundary_snapshot(
                run_root,
                step=step_name,
                index=index,
                next_step=step_name,
                artifacts=store.keys(),
                place=None,
                status="failed",
            )
            raise
        finally:
            object.__setattr__(self, "_aq_persist", False)
        nxt = object.__getattribute__(self, "_aq_next")
        next_name = getattr(nxt, "__name__", None) if nxt else None
        self._boundary(
            run_root,
            store,
            step_name=step_name,
            next_name=next_name,
            index=index,
            place=None,
        )
        return next_name

    def _run_step_remote(
        self,
        *,
        place_name: str,
        step_name: str,
        train: Path,
        run_root: Path,
        run_id: str,
        flow_file: Path,
    ) -> str | None:
        qualname = type(self).__qualname__
        try:
            flow_rel = flow_file.resolve().relative_to(train.resolve())
            flow_arg = str(flow_rel)
        except ValueError:
            flow_arg = str(flow_file)

        cmd = [
            "python3",
            "-m",
            "aquin.flow_worker",
            "--train",
            ".",
            "--flow-file",
            flow_arg,
            "--class",
            qualname,
            "--step",
            step_name,
            "--run-id",
            run_id,
        ]

        store = ArtifactStore(run_root)
        idx = len(done_steps(run_root))
        write_cursor(
            run_root,
            status="running",
            step=step_name,
            next_step=None,
            done=done_steps(run_root),
        )
        try:
            if place_name == "local":
                # Same machine, worker subprocess — same artifact paths, no SSH
                import os

                env = os.environ.copy()
                pkg = str(Path(__file__).resolve().parent.parent)
                env["PYTHONPATH"] = pkg + os.pathsep + env.get("PYTHONPATH", "")
                cmd[0] = sys.executable
                r = subprocess.run(cmd, cwd=str(train), capture_output=True, text=True, env=env)
                if r.returncode != 0:
                    raise RuntimeError(
                        f"local flow worker failed ({r.returncode}):\n{r.stderr or r.stdout}"
                    )
            else:
                from aquin.fleet import Place

                place = Place(place_name)
                # push train (includes artifacts/flow) — transfer glue is automatic
                place.sync(train)
                job = place.run(cmd)
                st = job.wait()
                code = st.get("code")
                status = str(st.get("status") or "")
                if status not in ("", "exited", "done") or (code is not None and int(code) != 0):
                    raise RuntimeError(
                        f"remote step {step_name!r} on {place_name!r} failed: {st}\n{job.logs()}"
                    )
                aq_bin = shutil.which("aq") or "aq"
                subprocess.run(
                    [aq_bin, "jobs", "pull", job.id, "--on", place_name],
                    cwd=str(train),
                    check=False,
                    capture_output=True,
                    text=True,
                )
        except Exception as e:
            write_cursor(
                run_root,
                status="failed",
                step=step_name,
                next_step=step_name,
                done=done_steps(run_root),
                error=f"{type(e).__name__}: {e}",
            )
            write_boundary_snapshot(
                run_root,
                step=step_name,
                index=idx,
                next_step=step_name,
                artifacts=store.keys(),
                place=place_name,
                status="failed",
            )
            raise

        next_name = _read_next(run_root, step_name)
        self._boundary(
            run_root,
            store,
            step_name=step_name,
            next_name=next_name,
            index=idx,
            place=place_name,
        )
        return next_name

    def run(
        self,
        train: str | Path = ".",
        *,
        run_id: str | None = None,
        place: str | None = None,
        resume: bool | str = False,
    ) -> dict[str, Any]:
        """Execute from ``start``, persisting artifacts between steps.

        ``place`` — default fleet place for steps that omit ``@step(place=…)``.
        Use ``place=\"local\"`` on a step (or here) to run the worker subprocess
        on this machine (same artifact paths, no SSH).

        ``resume`` — ``True`` resumes ``latest`` incomplete run; a string resumes
        that ``run_id``. Skips ``done/`` steps and continues from ``cursor.json``.
        """
        root = Path(train).expanduser().resolve()
        name = type(self).__name__

        resume_from: str | None = None
        skipped: list[str] = []
        if resume:
            if resume is True:
                rid_resume = latest_run_id(root, name)
                if not rid_resume:
                    raise FileNotFoundError(f"no prior {name} run to resume under {root}")
            else:
                rid_resume = str(resume)
            run_root = root / "artifacts" / "flow" / name / rid_resume
            if not run_root.is_dir():
                # safe-name folder
                from aquin.flow_store import flow_base

                run_root = flow_base(root, name) / rid_resume
            if not run_root.is_dir():
                raise FileNotFoundError(f"no flow run dir: {run_root}")
            rid = rid_resume
            resume_from, skipped = resume_entry(run_root)
            if resume_from is None:
                cur = read_cursor(run_root) or {}
                return {
                    "flow": name,
                    "run_id": rid,
                    "train": str(root),
                    "path": str(run_root),
                    "steps": [],
                    "skipped": skipped,
                    "places": [],
                    "artifacts": ArtifactStore(run_root).keys(),
                    "resumed": True,
                    "status": cur.get("status") or "ok",
                    "message": "already complete",
                }
            # refresh latest pointer
            flow_run_dir(root, name, run_id=rid)
        else:
            run_root, rid = flow_run_dir(root, name, run_id=run_id)

        store = ArtifactStore(run_root)

        object.__setattr__(self, "_aq_train", root)
        object.__setattr__(self, "_aq_run_id", rid)
        object.__setattr__(self, "_aq_run_root", run_root)
        object.__setattr__(self, "_aq_store", store)
        object.__setattr__(self, "_aq_flow_file", None)
        object.__setattr__(self, "_aq_default_place", place)

        start = getattr(self, "start", None)
        if start is None or not getattr(getattr(start, "__func__", start), "_aq_step", False):
            raise TypeError(f"{name} needs a @step start(self) method")

        # materialize source only if any step (or default) needs a worker
        needs_worker = bool(place)
        for _, v in inspect.getmembers(type(self), predicate=inspect.isfunction):
            if getattr(v, "_aq_step", False) and getattr(v, "_aq_place", None):
                needs_worker = True
                break
        flow_file: Path | None = None
        if needs_worker:
            flow_file = _resolve_flow_file(type(self), root, run_root)
            object.__setattr__(self, "_aq_flow_file", flow_file)
            (run_root / "origin.json").write_text(
                json.dumps(
                    {
                        "file": str(flow_file),
                        "qualname": type(self).__qualname__,
                        "module": type(self).__module__,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

        if resume_from:
            current = getattr(self, resume_from, None)
            if current is None or not getattr(getattr(current, "__func__", current), "_aq_step", False):
                raise RuntimeError(f"resume step {resume_from!r} missing or not a @step")
        else:
            current = start

        visited: list[str] = []
        places_used: list[str | None] = []
        index = len(done_steps(run_root))
        while current is not None:
            step_name = getattr(current, "__name__", "step")
            if step_name in visited:
                raise RuntimeError(f"flow cycle at step {step_name!r}")
            # skip already-done steps (resume)
            if is_step_done(run_root, step_name) and step_name != resume_from:
                # follow recorded next
                next_name = _read_next(run_root, step_name)
                skipped.append(step_name)
                if next_name:
                    current = getattr(self, next_name, None)
                    continue
                break

            visited.append(step_name)
            object.__setattr__(self, "_aq_step_name", step_name)

            step_place = _step_place(current) or place
            places_used.append(step_place)

            if step_place:
                if flow_file is None:
                    flow_file = _resolve_flow_file(type(self), root, run_root)
                    object.__setattr__(self, "_aq_flow_file", flow_file)
                next_name = self._run_step_remote(
                    place_name=step_place,
                    step_name=step_name,
                    train=root,
                    run_root=run_root,
                    run_id=rid,
                    flow_file=flow_file,
                )
            else:
                next_name = self._run_step_local(
                    current, store, run_root, step_name, index=index
                )
            index += 1
            resume_from = None  # only force first resume step once

            if next_name:
                nxt_fn = getattr(self, next_name, None)
                if nxt_fn is None or not getattr(getattr(nxt_fn, "__func__", nxt_fn), "_aq_step", False):
                    raise RuntimeError(f"next step {next_name!r} missing or not a @step")
                current = nxt_fn
            else:
                current = None

        summary = {
            "flow": name,
            "run_id": rid,
            "train": str(root),
            "path": str(run_root),
            "steps": visited,
            "skipped": skipped,
            "places": places_used,
            "artifacts": store.keys(),
            "resumed": bool(resume),
            "status": (read_cursor(run_root) or {}).get("status") or "ok",
        }
        (run_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        return summary


def flow_steps(cls: type) -> list[str]:
    """Names of ``@step`` methods on a Flow class."""
    names: list[str] = []
    for n, v in inspect.getmembers(cls, predicate=inspect.isfunction):
        if getattr(v, "_aq_step", False):
            names.append(n)
    return sorted(names)
