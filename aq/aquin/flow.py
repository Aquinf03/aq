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
import time
from pathlib import Path
from typing import Any, Callable

from aquin.client import Aquin
from aquin.flow_code import read_flow_code, snapshot_flow_code
from aquin.flow_store import (
    ArtifactStore,
    FlowArtifacts,
    LayeredStore,
    attempt_root,
    clone_run_for_resume,
    done_steps,
    flow_base,
    flow_run_dir,
    is_step_done,
    latest_run_id,
    make_attempt_store,
    mark_step_done,
    add_run_tags,
    all_run_tags,
    open_flow_artifacts,
    parse_flow_ref,
    pathspec,
    promote_attempt,
    read_origin,
    read_steps,
    read_visible_attempt,
    record_import,
    resume_entry,
    set_system_tag,
    write_attempt_meta,
    write_boundary_snapshot,
    write_origin,
    write_steps,
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


def retry(
    fn: Callable[..., Any] | None = None,
    *,
    times: int = 3,
    minutes_between_retries: float = 0,
):
    """Retry a ``@step`` on failure. Only the **last successful attempt** is visible.

    Failed attempts stay under ``attempts/<step>/<n>/`` for forensics; the run's
    ``artifacts/`` only gets outputs from the attempt that succeeded.

    ``times`` — retries after the first try (``times=0`` → single attempt, no retry).
    ``minutes_between_retries`` — sleep between attempts.
    """

    def deco(f: Callable[..., Any]) -> Callable[..., Any]:
        setattr(f, "_aq_retry_times", int(times))
        setattr(f, "_aq_retry_minutes", float(minutes_between_retries))
        return f

    if fn is not None:
        return deco(fn)
    return deco


def _step_retry(fn: Callable[..., Any]) -> tuple[int | None, float]:
    """Return ``(times, minutes)`` if ``@retry`` was applied; else ``(None, 0)``."""
    raw = getattr(fn, "__func__", fn)
    if not hasattr(raw, "_aq_retry_times"):
        return None, 0.0
    return int(getattr(raw, "_aq_retry_times")), float(getattr(raw, "_aq_retry_minutes", 0) or 0)


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
        Prep().run(".", resume=True)   # clone prior run; origin_pathspec stamped
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
            "code",
            "origin_pathspec",
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
        object.__setattr__(self, "_aq_code", None)
        object.__setattr__(self, "_aq_origin", None)

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

    @property
    def code(self) -> dict[str, Any] | None:
        """Code package for this run — ``tree.tgz`` of FlowSpec + aquin runtime.

        Keys: ``sha256``, ``tree``, ``manifest``, ``n_files``, …
        """
        cached = object.__getattribute__(self, "_aq_code")
        if cached is not None:
            return cached
        run_root = object.__getattribute__(self, "_aq_run_root")
        if run_root is None:
            return None
        return read_flow_code(Path(run_root))

    @property
    def origin_pathspec(self) -> str | None:
        """Where this run was cloned/resumed from, e.g. ``Prep/2026…/mid``."""
        cached = object.__getattribute__(self, "_aq_origin")
        if isinstance(cached, dict) and cached.get("origin_pathspec"):
            return str(cached["origin_pathspec"])
        run_root = object.__getattribute__(self, "_aq_run_root")
        if run_root is None:
            return None
        origin = read_origin(Path(run_root))
        if origin and origin.get("origin_pathspec"):
            return str(origin["origin_pathspec"])
        return None

    def artifacts(self) -> dict[str, Any]:
        """All persisted ``self.*`` values for this flow run."""
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            return {}
        return store.load_all()

    def artifact_ids(self) -> dict[str, str]:
        """name → ``sha256:…`` content ids for this flow run."""
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            return {}
        return store.ids()

    def verify(self) -> dict[str, Any]:
        """Re-hash CAS blobs; fail closed if anything was tampered with."""
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            run_root = object.__getattribute__(self, "_aq_run_root")
            if run_root is None:
                raise RuntimeError("no flow run loaded — call run() first or pass a store root")
            store = ArtifactStore(run_root)
        return store.verify()

    def _drop_user_attrs(self) -> None:
        for name in list(vars(self).keys()):
            if name.startswith("_"):
                continue
            object.__delattr__(self, name)

    def _load_store_attrs(self, store: ArtifactStore) -> None:
        self._drop_user_attrs()
        for k, v in store.load_all().items():
            object.__setattr__(self, k, v)

    def attempt_artifacts(self, step: str, attempt: int | None = None) -> dict[str, Any]:
        """Load artifacts from a retry attempt (forensics). Default: visible attempt."""
        run_root = object.__getattribute__(self, "_aq_run_root")
        if run_root is None:
            raise RuntimeError("no flow run loaded — call run() first")
        root = Path(run_root)
        n = attempt if attempt is not None else read_visible_attempt(root, step)
        if n is None:
            return {}
        ar = attempt_root(root, step, n)
        if not ar.is_dir():
            return {}
        return ArtifactStore(ar, cas=root / "cas").load_all()

    def from_flow(
        self,
        flow: str,
        *,
        run: str | None = None,
        successful: bool = True,
        train: str | Path | None = None,
    ) -> FlowArtifacts:
        """Open another flow run's artifacts (read-only).

        ``flow`` — ``Prep``, ``Prep/<run_id>``, or pass ``run=``.
        Defaults to the latest **successful** run under this train folder.
        """
        root = train or object.__getattribute__(self, "_aq_train")
        if root is None:
            raise RuntimeError("no train folder — pass train= or call inside run()")
        return open_flow_artifacts(root, flow, run=run, successful=successful)

    def input(
        self,
        flow: str,
        name: str | None = None,
        *,
        run: str | None = None,
        successful: bool = True,
    ) -> Any:
        """Read one artifact from another flow (no write into this run).

        ``self.input("Prep", "rows")`` or ``self.input("Prep/<run>#rows")``.
        """
        flow_ref, embedded_run, embedded_art = parse_flow_ref(flow)
        art = name or embedded_art
        if not art:
            raise TypeError("input() needs an artifact name or Flow/run#artifact ref")
        src = self.from_flow(
            flow_ref if not embedded_run else f"{flow_ref}/{embedded_run}",
            run=run or embedded_run,
            successful=successful,
        )
        return src.get(art)

    def import_from(
        self,
        flow: str,
        *names: str,
        run: str | None = None,
        rename: dict[str, str] | None = None,
        successful: bool = True,
    ) -> dict[str, Any]:
        """Copy artifacts from another flow into **this** run with ``origin_pathspec``.

        Examples::

            self.import_from("Prep", "rows")              # → self.rows
            self.import_from("Prep")                      # all artifacts
            self.import_from("Prep", rename={"features": "rows"})  # local ← source
        """
        store = object.__getattribute__(self, "_aq_store")
        run_root = object.__getattribute__(self, "_aq_run_root")
        if store is None or run_root is None:
            raise RuntimeError("import_from() needs an active flow run — call inside a @step")

        src = self.from_flow(flow, run=run, successful=successful)
        # map: dest_name -> source_name
        mapping: dict[str, str] = {}
        if rename:
            mapping.update(rename)
        if names:
            for n in names:
                mapping.setdefault(n, n)
        if not mapping:
            for n in src.keys():
                mapping[n] = n

        out: dict[str, Any] = {}
        for dest_name, src_name in mapping.items():
            val = src.get(src_name)
            origin = src.origin_of(src_name)
            store.put(dest_name, val, origin_pathspec=origin)
            object.__setattr__(self, dest_name, val)
            record_import(
                Path(run_root),
                {
                    "source_flow": src.flow,
                    "source_run": src.run_id,
                    "source_artifact": src_name,
                    "dest_artifact": dest_name,
                    "origin_pathspec": origin,
                    "step": object.__getattribute__(self, "_aq_step_name"),
                },
            )
            out[dest_name] = val
        return out

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
        attempt: int | None = None,
    ) -> None:
        """Snapshot + done marker + steps.json after a step boundary."""
        extra: dict[str, Any] = {}
        if attempt is not None:
            extra["attempt"] = attempt
            extra["visible_attempt"] = attempt
        write_step_meta(
            run_root,
            step_name,
            artifacts=store.keys(),
            next=next_name,
            place=place,
            status=status,
            **extra,
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
            artifact_ids=store.ids(),
            **extra,
        )
        write_steps(
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
        retry_times, retry_minutes = _step_retry(method)
        write_steps(
            run_root,
            status="running",
            step=step_name,
            next_step=None,
            done=done_steps(run_root),
        )

        if retry_times is None:
            # no @retry — write straight to visible artifacts/
            object.__setattr__(self, "_aq_next", None)
            self._load_store_attrs(store)
            object.__setattr__(self, "_aq_store", store)
            object.__setattr__(self, "_aq_persist", True)
            try:
                method()
            except Exception as e:
                object.__setattr__(self, "_aq_persist", False)
                write_steps(
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

        max_attempts = 1 + max(0, retry_times)
        last_err: BaseException | None = None
        for attempt in range(max_attempts):
            attempt_store = make_attempt_store(run_root, step_name, attempt)
            layered = LayeredStore(store, attempt_store)
            object.__setattr__(self, "_aq_next", None)
            object.__setattr__(self, "_aq_store", layered)
            object.__setattr__(self, "_aq_attempt", attempt)
            self._load_store_attrs(store)
            object.__setattr__(self, "_aq_persist", True)
            try:
                method()
            except Exception as e:
                object.__setattr__(self, "_aq_persist", False)
                last_err = e
                write_attempt_meta(
                    run_root,
                    step_name,
                    attempt,
                    status="failed",
                    error=f"{type(e).__name__}: {e}",
                    artifacts=attempt_store.keys(),
                    visible=False,
                )
                if attempt + 1 >= max_attempts:
                    object.__setattr__(self, "_aq_store", store)
                    write_steps(
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
                        attempt=attempt,
                    )
                    raise
                if retry_minutes > 0:
                    time.sleep(retry_minutes * 60)
                continue
            finally:
                object.__setattr__(self, "_aq_persist", False)

            # success — promote attempt → visible results only
            promote_attempt(store, attempt_store)
            write_attempt_meta(
                run_root,
                step_name,
                attempt,
                status="ok",
                artifacts=attempt_store.keys(),
                visible=True,
            )
            object.__setattr__(self, "_aq_store", store)
            nxt = object.__getattribute__(self, "_aq_next")
            next_name = getattr(nxt, "__name__", None) if nxt else None
            self._boundary(
                run_root,
                store,
                step_name=step_name,
                next_name=next_name,
                index=index,
                place=None,
                attempt=attempt,
            )
            return next_name

        assert last_err is not None
        raise last_err

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
        method = getattr(self, step_name)
        retry_times, retry_minutes = _step_retry(method)
        max_attempts = 1 if retry_times is None else (1 + max(0, retry_times))
        use_attempts = retry_times is not None

        qualname = type(self).__qualname__
        try:
            flow_rel = flow_file.resolve().relative_to(train.resolve())
            flow_arg = str(flow_rel)
        except ValueError:
            flow_arg = str(flow_file)

        store = ArtifactStore(run_root)
        idx = len(done_steps(run_root))
        write_steps(
            run_root,
            status="running",
            step=step_name,
            next_step=None,
            done=done_steps(run_root),
        )

        last_err: BaseException | None = None
        for attempt in range(max_attempts):
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
            if use_attempts:
                cmd.extend(["--attempt", str(attempt)])
                make_attempt_store(run_root, step_name, attempt)  # fresh dir before sync

            try:
                if place_name == "local":
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
                last_err = e
                if use_attempts:
                    ar = attempt_root(run_root, step_name, attempt)
                    arts = (
                        ArtifactStore(ar, cas=run_root / "cas").keys() if ar.is_dir() else []
                    )
                    write_attempt_meta(
                        run_root,
                        step_name,
                        attempt,
                        status="failed",
                        error=f"{type(e).__name__}: {e}",
                        artifacts=arts,
                        visible=False,
                    )
                if attempt + 1 >= max_attempts:
                    write_steps(
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
                        attempt=attempt if use_attempts else None,
                    )
                    raise
                if retry_minutes > 0:
                    time.sleep(retry_minutes * 60)
                continue

            # success
            if use_attempts:
                ar = attempt_root(run_root, step_name, attempt)
                attempt_store = ArtifactStore(ar, cas=run_root / "cas")
                promote_attempt(store, attempt_store)
                write_attempt_meta(
                    run_root,
                    step_name,
                    attempt,
                    status="ok",
                    artifacts=attempt_store.keys(),
                    visible=True,
                )
            next_name = _read_next(run_root, step_name)
            self._boundary(
                run_root,
                store,
                step_name=step_name,
                next_name=next_name,
                index=idx,
                place=place_name,
                attempt=attempt if use_attempts else None,
            )
            return next_name

        assert last_err is not None
        raise last_err

    def run(
        self,
        train: str | Path = ".",
        *,
        run_id: str | None = None,
        place: str | None = None,
        resume: bool | str = False,
        clone: bool = True,
        tags: str | list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        """Execute from ``start``, persisting artifacts between steps.

        ``place`` — default fleet place for steps that omit ``@step(place=…)``.
        Use ``place=\"local\"`` on a step (or here) to run the worker subprocess
        on this machine (same artifact paths, no SSH).

        ``resume`` — ``True`` resumes ``latest`` incomplete run; a string resumes
        that ``run_id``. By default ``clone=True``: successful steps are copied into
        a **new** run with ``origin_pathspec`` lineage. ``clone=False`` continues
        in-place.

        ``tags`` — user labels on this run (``env=prod``); filter later with
        ``runs("Prep", tags=[…])``. System tags (``sys:…``) are stamped automatically.
        """
        root = Path(train).expanduser().resolve()
        name = type(self).__name__

        resume_from: str | None = None
        skipped: list[str] = []
        origin_meta: dict[str, Any] | None = None
        if resume:
            if resume is True:
                rid_src = latest_run_id(root, name)
                if not rid_src:
                    raise FileNotFoundError(f"no prior {name} run to resume under {root}")
            else:
                rid_src = str(resume)
            src_root = root / "artifacts" / "flow" / name / rid_src
            if not src_root.is_dir():
                src_root = flow_base(root, name) / rid_src
            if not src_root.is_dir():
                raise FileNotFoundError(f"no flow run dir: {src_root}")
            resume_from, skipped = resume_entry(src_root)
            if resume_from is None:
                cur = read_steps(src_root) or {}
                return {
                    "flow": name,
                    "run_id": rid_src,
                    "train": str(root),
                    "path": str(src_root),
                    "steps": [],
                    "skipped": skipped,
                    "places": [],
                    "artifacts": ArtifactStore(src_root).keys(),
                    "code": read_flow_code(src_root),
                    "origin_pathspec": (read_origin(src_root) or {}).get("origin_pathspec"),
                    "resumed": True,
                    "status": cur.get("status") or "ok",
                    "message": "already complete",
                }
            if clone:
                run_root, rid = flow_run_dir(root, name, run_id=run_id)
                origin_meta = clone_run_for_resume(
                    src_root,
                    run_root,
                    flow=name,
                    source_run_id=rid_src,
                    resume_step=resume_from,
                )
                skipped = list(origin_meta.get("done") or skipped)
            else:
                rid = rid_src
                run_root = src_root
                flow_run_dir(root, name, run_id=rid)
                origin_meta = write_origin(
                    run_root,
                    origin_pathspec=pathspec(name, rid_src, resume_from),
                    source_run=rid_src,
                    resume_step=resume_from,
                    cloned=False,
                )
        else:
            run_root, rid = flow_run_dir(root, name, run_id=run_id)

        store = ArtifactStore(run_root)
        set_system_tag(run_root, "flow", name)
        set_system_tag(run_root, "status", "running")
        if tags:
            tag_list = [tags] if isinstance(tags, str) else list(tags)
            if tag_list:
                add_run_tags(run_root, *tag_list, system=False)

        object.__setattr__(self, "_aq_train", root)
        object.__setattr__(self, "_aq_run_id", rid)
        object.__setattr__(self, "_aq_run_root", run_root)
        object.__setattr__(self, "_aq_store", store)
        object.__setattr__(self, "_aq_flow_file", None)
        object.__setattr__(self, "_aq_default_place", place)
        object.__setattr__(self, "_aq_code", None)
        object.__setattr__(self, "_aq_origin", origin_meta)

        start = getattr(self, "start", None)
        if start is None or not getattr(getattr(start, "__func__", start), "_aq_step", False):
            raise TypeError(f"{name} needs a @step start(self) method")

        # materialize source for code package (+ worker if needed)
        needs_worker = bool(place)
        for _, v in inspect.getmembers(type(self), predicate=inspect.isfunction):
            if getattr(v, "_aq_step", False) and getattr(v, "_aq_place", None):
                needs_worker = True
                break
        flow_file: Path | None = None
        try:
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
        except TypeError:
            if needs_worker:
                raise
            flow_file = None

        # freeze FlowSpec + aquin runtime before steps (esp. remote sync)
        code_meta = snapshot_flow_code(
            root, run_root, flow_file=flow_file, flow_name=name
        )
        object.__setattr__(self, "_aq_code", code_meta)

        if resume_from:
            current = getattr(self, resume_from, None)
            if current is None or not getattr(getattr(current, "__func__", current), "_aq_step", False):
                raise RuntimeError(f"resume step {resume_from!r} missing or not a @step")
        else:
            current = start

        visited: list[str] = []
        places_used: list[str | None] = []
        index = len(done_steps(run_root))
        try:
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
        except Exception:
            set_system_tag(run_root, "status", "failed")
            raise

        origin_out = origin_meta or read_origin(run_root)
        final_status = (read_steps(run_root) or {}).get("status") or "ok"
        set_system_tag(run_root, "status", str(final_status))

        summary = {
            "flow": name,
            "run_id": rid,
            "train": str(root),
            "path": str(run_root),
            "steps": visited,
            "skipped": skipped,
            "places": places_used,
            "artifacts": store.keys(),
            "code": {
                "sha256": code_meta.get("sha256") if code_meta else None,
                "tree": code_meta.get("rel_tree") if code_meta else None,
                "n_files": code_meta.get("n_files") if code_meta else None,
            }
            if code_meta
            else read_flow_code(run_root),
            "origin_pathspec": (origin_out or {}).get("origin_pathspec") if origin_out else None,
            "resumed": bool(resume),
            "status": final_status,
            "tags": all_run_tags(run_root),
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
