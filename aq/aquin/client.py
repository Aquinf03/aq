"""Aquin client — SDK authors; recipe.yaml is the path map; paths: sets the layout."""

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
        aq.train()
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
        paths: dict[str, Any] | None = None,
        **fields: Any,
    ) -> "Aquin":
        """
        Author a run in Python and write recipe.yaml as the path map.

        Pass a dict and/or keyword fields (family, method, data, eval, paths, …).
        `artifacts=` is shorthand for `paths.artifacts` (persisted in YAML).
        """
        out: dict[str, Any] = {}
        if recipe:
            out.update(recipe)
        for k, v in fields.items():
            if v is not None:
                out[k] = v
        if paths:
            merged = dict(out.get("paths") or {})
            merged.update({k: v for k, v in paths.items() if v is not None})
            out["paths"] = merged
        if "family" not in out or "method" not in out:
            raise ValueError("define() needs family and method")
        if "data" not in out:
            raise ValueError("define() needs data (with path)")
        if "eval" not in out:
            raise ValueError("define() needs eval (with metric)")

        cfg = Path(config_path).expanduser()
        root = cfg.parent if cfg.suffix in (".yaml", ".yml") else cfg
        if cfg.suffix not in (".yaml", ".yml"):
            cfg = root / "recipe.yaml"
            root = root.resolve()
        else:
            root = root.resolve()

        art_arg: str | Path | None = artifacts
        if artifacts is not None:
            art_path = Path(artifacts).expanduser()
            if not art_path.is_absolute():
                rel = str(art_path).replace("\\", "/")
            else:
                try:
                    rel = str(art_path.resolve().relative_to(root)).replace("\\", "/")
                except ValueError:
                    rel = str(art_path.resolve())
            merged = dict(out.get("paths") or {})
            merged["artifacts"] = rel
            out["paths"] = merged
            art_arg = (root / rel).resolve() if not Path(rel).is_absolute() else Path(rel)

        path = dump_recipe(out, cfg)
        return cls(path, artifacts=art_arg, _recipe=dict(out))

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

    def train(
        self,
        *,
        stream: bool = False,
        system: bool = False,
        grads: bool = False,
    ) -> list[str] | Iterator[str]:
        """Fit the recipe. Writes checkpoints under artifacts/checkpoints/."""
        # Ensure framework hooks are on for this process (also installed in metrics.begin).
        try:
            from aquin.autolog import autolog as _autolog

            _autolog(system=system, grads=grads)
        except Exception:
            pass
        kw: dict[str, Any] = {}
        if system:
            kw["capture_system"] = True
        if grads:
            kw["capture_grads"] = True
        if stream:
            lines = bridge.invoke(self._handle, "train", **kw)
            return iter(lines)
        return bridge.invoke(self._handle, "train", **kw)

    def autolog(self, *frameworks: str, system: bool = False, grads: bool = False) -> list[str]:
        """Enable framework integrations for this run folder."""
        from aquin.autolog import autolog as _autolog

        return _autolog(*frameworks, train=self.root, system=system, grads=grads)

    def log_params(self, params: dict[str, Any]) -> None:
        from aquin.autolog import log_params as _log_params

        _log_params(params, train=self.root)

    def log_param(self, key: str | dict[str, Any], value: Any = None) -> None:
        from aquin.autolog import log_param as _log_param

        _log_param(key, value, train=self.root)

    def log_metric(self, key: str, value: float | int, *, step: int | None = None) -> None:
        from aquin.autolog import log_metric as _log_metric

        _log_metric(key, value, step=step, train=self.root)

    def log_metrics(self, metrics: dict[str, Any], *, step: int | None = None) -> None:
        from aquin.autolog import log_metrics as _log_metrics

        _log_metrics(metrics, step=step, train=self.root)

    def log_model(self, checkpoint: str | Path | None = None) -> str | None:
        """Bind checkpoint as logged model (stable id linked to dataset)."""
        from aquin.autolog import log_model as _log_model

        return _log_model(checkpoint, train=self.root)

    def log_system(self) -> dict[str, Any]:
        """Sample CPU/GPU/mem/disk/net once into metrics.jsonl."""
        from aquin.autolog import log_system as _log_system

        return _log_system(train=self.root)

    def log_infra(
        self,
        kind: str,
        message: str | None = None,
        *,
        step: int | None = None,
        **fields: Any,
    ) -> dict[str, Any]:
        """Stamp a discrete infra incident (OOM / preempt / …) onto the run timeline."""
        from aquin.autolog import log_infra as _log_infra

        return _log_infra(kind, message, train=self.root, step=step, **fields)

    def evaluate(
        self,
        y_true: Any,
        y_pred: Any,
        y_prob: Any = None,
        *,
        task: str | None = None,
        average: str = "macro",
        plots: bool = True,
        path: str | None = None,
        **extras: Any,
    ) -> dict[str, Any]:
        """Standard metrics + plots (+ optional extra named scores) on this run."""
        from aquin.autolog import evaluate as _evaluate

        return _evaluate(
            y_true,
            y_pred,
            y_prob,
            train=self.root,
            task=task,
            average=average,
            plots=plots,
            path=path,
            **extras,
        )

    def start_system(self, interval: float = 2.0) -> None:
        """Background system metrics (same as ``aq train --system``)."""
        from aquin.autolog import start_system as _start_system

        _start_system(train=self.root, interval=interval)

    def stop_system(self) -> None:
        from aquin.autolog import stop_system as _stop_system

        _stop_system()

    def enable_grads(self, every: int = 50) -> None:
        from aquin.autolog import enable_grads as _enable_grads

        _enable_grads(train=self.root, every=every)

    def log_grads(self, model: Any = None, *, step: int | None = None) -> dict[str, Any]:
        from aquin.autolog import log_grads as _log_grads

        return _log_grads(model, step=step, train=self.root)

    def table(self, *args: Any, step: int | None = None, **fields: Any) -> str:
        """Append one row to artifacts/tables (see aquin.table)."""
        from aquin.autolog import table as _table

        return _table(*args, train=self.root, step=step, **fields)

    def set_tags(self, *tags: str, replace: bool = False) -> list[str]:
        from aquin.autolog import set_tags as _set_tags

        return _set_tags(*tags, replace=replace, train=self.root)

    def add_tags(self, *tags: str) -> list[str]:
        return self.set_tags(*tags, replace=False)

    def set_notes(self, text: str | None) -> str:
        from aquin.autolog import set_notes as _set_notes

        return _set_notes(text, train=self.root)

    def finish(self, **meta: Any) -> dict[str, str]:
        """End a standalone tracking session (writes runs/<id>.json when op=log)."""
        from aquin.autolog import finish as _finish

        return _finish(**meta)

    def eval(
        self,
        name: str | None = None,
        *,
        ckpt: str | None = None,
        system: bool = False,
    ) -> list[str]:
        """Score probes in evals/ (or training gate)."""
        kw: dict[str, Any] = {"probe": name, "ckpt": ckpt}
        if system:
            kw["capture_system"] = True
        return bridge.invoke(self._handle, "eval", **kw)

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

    def plot(
        self,
        kind: str | None = None,
        *,
        charts: list[str] | str | None = None,
        fields: list[str] | str | None = None,
        x: str | None = None,
        style: str | None = None,
        title: str | None = None,
        figsize: list[float] | tuple[float, float] | str | None = None,
        show_lr: bool | None = None,
        metric_charts: list[str] | str | None = None,
        max: int | None = None,
        thumb: int | None = None,
        nrow: int | None = None,
        from_dirs: list[str] | str | None = None,
        backend: str | None = None,
        format: str | None = None,
        dpi: int | None = None,
        out: str | None = None,
        metrics: dict[str, Any] | None = None,
        samples: dict[str, Any] | None = None,
        jobs: dict[str, Any] | None = None,
        runs: dict[str, Any] | None = None,
        **extra: Any,
    ) -> list[str]:
        """
        Generate charts under artifacts/plots/.

        kind: metrics | jobs | runs | samples | all
        Or pass charts=['metrics','samples'] for an explicit set.

        Example::

            aq.plot('metrics', fields=['loss'], title='loss', style='line')
            aq.plot('samples', max=32, nrow=4, from_dirs='artifacts/samples')
            aq.plot(charts=['metrics', 'samples'], dpi=200)
        """
        fz: Any = figsize
        if isinstance(figsize, tuple):
            fz = list(figsize)
        payload: dict[str, Any] = {
            "kind": kind or "all",
            "charts": charts,
            "fields": fields,
            "x": x,
            "style": style,
            "title": title,
            "figsize": fz,
            "show_lr": show_lr,
            "metric_charts": metric_charts,
            "max": max,
            "thumb": thumb,
            "nrow": nrow,
            "backend": backend,
            "format": format,
            "dpi": dpi,
            "out": out,
            "metrics": metrics,
            "samples": samples,
            "jobs": jobs,
            "runs": runs,
        }
        if from_dirs is not None:
            payload["from"] = from_dirs
        payload.update(extra)
        return bridge.invoke(self._handle, "plot", **payload)

    def status(self) -> dict[str, Any]:
        """Lightweight status from artifacts (path map + runtime pointers)."""
        art = self.artifacts
        out: dict[str, Any] = {
            "root": str(self.root),
            "config": str(self.config_path),
            "artifacts": str(art),
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
