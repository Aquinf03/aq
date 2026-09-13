"""Aquin client — SDK + YAML + artifacts/."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from aquin import bridge
from aquin.handle import RunHandle, open_run
from aquin.recipe_io import dump_recipe


class Aquin:
    """
    Few-line client over the aq kernel.

        aq = Aquin("recipe.yaml")
        aq.train()
        aq.eval()
    """

    def __init__(self, config: str | Path, artifacts: str | Path | None = None):
        self._handle: RunHandle = open_run(config, artifacts)

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        *,
        config_path: str | Path,
        artifacts: str | Path | None = None,
    ) -> "Aquin":
        """Build a client from a dict; always writes durable YAML."""
        path = dump_recipe(data, config_path)
        return cls(path, artifacts=artifacts)

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
            # Kernel still prints live metrics on stderr; yield result lines after.
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
        """Lightweight status from artifacts (no full CLI status yet)."""
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
