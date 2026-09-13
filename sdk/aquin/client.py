"""Aquin client — SDK authors; recipe.yaml is the path map; artifacts/ is runtime."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from aquin import bridge
from aquin.handle import RunHandle, open_run
from aquin.recipe_io import dump_recipe, load_recipe_dict


class Aquin:
    """
    Few-line client over the aq kernel.

    YAML-first (edit recipe.yaml, then open):

        aq = Aquin(".")
        aq.train()

    SDK-first (writes the same path map):

        aq = Aquin.define(..., config_path="recipe.yaml")
        aq.plan("nightly", kind="cron", every=60, run="train")
        aq.train()

    Mix: open YAML and add plans from code with .plan(...).
    """

    def __init__(
        self,
        config: str | Path,
        artifacts: str | Path | None = None,
        *,
        _recipe: dict[str, Any] | None = None,
    ):
        self._handle: RunHandle = open_run(config, artifacts)
        if _recipe is not None:
            self._recipe = _recipe
        elif self._handle.config_path.is_file():
            try:
                self._recipe = load_recipe_dict(self._handle.config_path)
            except Exception:
                self._recipe = {}
        else:
            self._recipe = {}

    @classmethod
    def define(
        cls,
        recipe: dict[str, Any] | None = None,
        *,
        config_path: str | Path,
        artifacts: str | Path | None = None,
        **fields: Any,
    ) -> "Aquin":
        """
        Author a run in Python and write recipe.yaml as the path map.

        Pass a dict and/or keyword fields (family, method, data, eval, plans, …).
        """
        out: dict[str, Any] = {}
        if recipe:
            out.update(recipe)
        for k, v in fields.items():
            if v is not None:
                out[k] = v
        if "family" not in out or "method" not in out:
            raise ValueError("define() needs family and method")
        if "data" not in out:
            raise ValueError("define() needs data (with path)")
        if "eval" not in out:
            raise ValueError("define() needs eval (with metric)")
        path = dump_recipe(out, config_path)
        return cls(path, artifacts=artifacts, _recipe=dict(out))

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        *,
        config_path: str | Path,
        artifacts: str | Path | None = None,
    ) -> "Aquin":
        """Build a client from a dict; always writes durable YAML (path map)."""
        return cls.define(data, config_path=config_path, artifacts=artifacts)

    def to_yaml(self, path: str | Path | None = None) -> Path:
        """Rewrite the path map from the in-memory recipe."""
        dest = Path(path) if path else self.config_path
        dump_recipe(self._recipe, dest)
        return dest

    def plan(self, name: str, **spec: Any) -> "Aquin":
        """Add/replace a named plan and rewrite recipe.yaml."""
        if "kind" not in spec:
            raise ValueError("plan() needs kind= (cron, sweep, resume, pipeline, agents)")
        plans = dict(self._recipe.get("plans") or {})
        plans[name] = dict(spec)
        self._recipe["plans"] = plans
        self.to_yaml()
        return self

    def plans(self) -> dict[str, Any]:
        """Plans declared in the path map (recipe.yaml)."""
        raw = self._recipe.get("plans") or {}
        return dict(raw) if isinstance(raw, dict) else {}

    @property
    def recipe(self) -> dict[str, Any]:
        return dict(self._recipe)

    @property
    def root(self) -> Path:
        return self._handle.root

    @property
    def config_path(self) -> Path:
        return self._handle.config_path

    @property
    def artifacts(self) -> Path:
        return self._handle.artifacts_dir

    def train(self, *, stream: bool = False) -> list[str] | Iterator[str]:
        """Fit the recipe. Writes checkpoints under artifacts/checkpoints/."""
        if stream:
            lines = bridge.invoke(self._handle, "train")
            return iter(lines)
        return bridge.invoke(self._handle, "train")

    def eval(self, name: str | None = None, *, ckpt: str | None = None) -> list[str]:
        """Score probes in evals/ (or training gate)."""
        return bridge.invoke(self._handle, "eval", probe=name, ckpt=ckpt)

    def checkpoint(self, keep: str | None = None) -> list[str]:
        return bridge.invoke(self._handle, "checkpoint", keep=keep)

    def serve(
        self,
        prompt: str | None = None,
        *,
        ckpt: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        image: str | None = None,
    ) -> list[str]:
        return bridge.invoke(
            self._handle,
            "serve",
            prompt=prompt,
            ckpt=ckpt,
            max_tokens=max_tokens,
            temperature=temperature,
            image=image,
        )

    def hash(self, *, snapshot: bool = False) -> list[str]:
        return bridge.invoke(self._handle, "hash", snapshot=snapshot)

    def status(self) -> dict[str, Any]:
        """Lightweight status from artifacts (path map + runtime pointers)."""
        art = self.artifacts
        out: dict[str, Any] = {
            "root": str(self.root),
            "config": str(self.config_path),
            "artifacts": str(art),
            "plans": list(self.plans().keys()),
        }
        last = art / "checkpoints" / "last.json"
        out["checkpoint"] = str(last) if last.is_file() else None
        ev = art / "eval.json"
        if ev.is_file():
            try:
                out["eval"] = json.loads(ev.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                out["eval"] = None
        else:
            out["eval"] = None
        metrics = art / "metrics.jsonl"
        out["metrics"] = str(metrics) if metrics.is_file() else None
        return out
