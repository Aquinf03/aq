"""SDK-authored runs — Python leads; recipe.yaml is the durable path map."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aquin.client import Aquin


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
