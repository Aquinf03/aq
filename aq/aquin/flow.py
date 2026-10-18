"""SDK-authored runs + multi-step Flow with auto-persisted ``self.x``.

``Run`` — class attrs → recipe.yaml path map.

``Flow`` — Metaflow-shaped steps; assigning ``self.x`` writes an artifact so the
next step can read it with no manual save/load.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, Callable

from aquin.client import Aquin
from aquin.flow_store import ArtifactStore, flow_run_dir, write_step_meta


def step(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Mark a Flow method as a step."""
    setattr(fn, "_aq_step", True)
    return fn


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


class Flow:
    """Multi-step flow: ``self.x = …`` persists between steps under ``artifacts/flow/``.

        from aquin import Flow, step

        class Prep(Flow):
            @step
            def start(self):
                self.rows = [[1.0, 2.0]]
                self.next(self.end)

            @step
            def end(self):
                assert self.rows == [[1.0, 2.0]]

        Prep().run(".")
    """

    _AQ_INTERNAL = frozenset(
        {
            "next",
            "run",
            "artifacts",
            "train",
            "run_id",
            "step_name",
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
        # load from store if missing in __dict__ (resume / cross-process)
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
        # unwrap bound method
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

    def artifacts(self) -> dict[str, Any]:
        """All persisted ``self.*`` values for this flow run."""
        store = object.__getattribute__(self, "_aq_store")
        if store is None:
            return {}
        return store.load_all()

    def run(
        self,
        train: str | Path = ".",
        *,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute from ``start``, persisting artifacts between steps."""
        root = Path(train).expanduser().resolve()
        if not (root / "recipe.yaml").is_file():
            # still allow flows outside a train folder — use cwd layout
            pass
        name = type(self).__name__
        run_root, rid = flow_run_dir(root, name, run_id=run_id)
        store = ArtifactStore(run_root)
        object.__setattr__(self, "_aq_train", root)
        object.__setattr__(self, "_aq_run_id", rid)
        object.__setattr__(self, "_aq_run_root", run_root)
        object.__setattr__(self, "_aq_store", store)

        start = getattr(self, "start", None)
        if start is None or not getattr(getattr(start, "__func__", start), "_aq_step", False):
            raise TypeError(f"{name} needs a @step start(self) method")

        current: Callable[..., Any] | None = start
        visited: list[str] = []
        while current is not None:
            step_name = getattr(current, "__name__", "step")
            if step_name in visited:
                raise RuntimeError(f"flow cycle at step {step_name!r}")
            visited.append(step_name)
            object.__setattr__(self, "_aq_step_name", step_name)
            object.__setattr__(self, "_aq_next", None)
            # hydrate prior artifacts into instance
            for k, v in store.load_all().items():
                object.__setattr__(self, k, v)
            object.__setattr__(self, "_aq_persist", True)
            try:
                current()
            finally:
                object.__setattr__(self, "_aq_persist", False)
            write_step_meta(
                run_root,
                step_name,
                artifacts=store.keys(),
                next=(
                    getattr(object.__getattribute__(self, "_aq_next"), "__name__", None)
                    if object.__getattribute__(self, "_aq_next")
                    else None
                ),
            )
            nxt = object.__getattribute__(self, "_aq_next")
            current = nxt

        summary = {
            "flow": name,
            "run_id": rid,
            "train": str(root),
            "path": str(run_root),
            "steps": visited,
            "artifacts": store.keys(),
        }
        (run_root / "summary.json").write_text(
            __import__("json").dumps(summary, indent=2) + "\n",
            encoding="utf-8",
        )
        return summary


def flow_steps(cls: type) -> list[str]:
    """Names of ``@step`` methods on a Flow class."""
    names: list[str] = []
    for n, v in inspect.getmembers(cls, predicate=inspect.isfunction):
        if getattr(v, "_aq_step", False):
            names.append(n)
    return sorted(names)
