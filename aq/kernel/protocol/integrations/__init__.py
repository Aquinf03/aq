"""Framework integration registry — install hooks so training libs auto-feed aq metrics.

Used from metrics.begin / aquin.autolog(). Each adapter is best-effort: missing libs are skipped.
"""

from __future__ import annotations

from typing import Any, Callable

# name -> installer(disable: bool) -> bool (True if hooked / unhooked)
_INSTALLERS: dict[str, Callable[[bool], bool]] = {}
_active: set[str] = set()


def _register(name: str, *aliases: str):
    def deco(fn: Callable[[bool], bool]):
        _INSTALLERS[name] = fn
        for a in aliases:
            _INSTALLERS[a] = fn
        return fn

    return deco


def available() -> list[str]:
    """Canonical framework names that have an installer."""
    seen: set[int] = set()
    out: list[str] = []
    for name, fn in sorted(_INSTALLERS.items()):
        i = id(fn)
        if i in seen:
            continue
        # Prefer short canonical names (no dashes duplicates): first key per fn
        seen.add(i)
        # find canonical = shortest name for this installer
        canon = min((k for k, v in _INSTALLERS.items() if v is fn), key=len)
        if canon not in out:
            out.append(canon)
    return out


def installed() -> list[str]:
    return sorted(_active)


def install(frameworks: list[str] | tuple[str, ...] | None = None) -> list[str]:
    """Enable hooks. None / empty / ['all'] → every importable adapter."""
    if frameworks is None or not frameworks or frameworks == ("all",) or frameworks == ["all"]:
        names = available()
    else:
        names = []
        for raw in frameworks:
            key = str(raw).strip().lower().replace("_", "-")
            if key in ("all", "*"):
                names = available()
                break
            if key not in _INSTALLERS:
                # unknown name — skip quietly (catalog aspiration)
                continue
            names.append(key)
        # unique by installer
        seen_fn: set[int] = set()
        uniq: list[str] = []
        for n in names:
            fn = _INSTALLERS[n]
            if id(fn) in seen_fn:
                continue
            seen_fn.add(id(fn))
            uniq.append(n)
        names = uniq

    hooked: list[str] = []
    for name in names:
        fn = _INSTALLERS.get(name)
        if not fn:
            continue
        try:
            if fn(False):
                _active.add(name)
                hooked.append(name)
        except Exception:
            continue
    return hooked


def disable(frameworks: list[str] | tuple[str, ...] | None = None) -> None:
    names = list(frameworks) if frameworks else list(_active)
    for name in names:
        key = str(name).strip().lower().replace("_", "-")
        fn = _INSTALLERS.get(key)
        if not fn:
            continue
        try:
            fn(True)
        except Exception:
            pass
        _active.discard(key)


# --- adapters (lazy imports inside) -------------------------------------------------


@_register("sklearn", "scikit-learn", "scikitlearn")
def _sklearn(disable: bool) -> bool:
    from protocol.integrations import sklearn_hook

    return sklearn_hook.apply(disable=disable)


@_register("transformers", "huggingface", "hf", "trainer")
def _transformers(disable: bool) -> bool:
    from protocol.integrations import transformers_hook

    return transformers_hook.apply(disable=disable)


@_register("xgboost", "xgb")
def _xgboost(disable: bool) -> bool:
    from protocol.integrations import xgboost_hook

    return xgboost_hook.apply(disable=disable)


@_register("lightgbm", "lgbm", "lgb")
def _lightgbm(disable: bool) -> bool:
    from protocol.integrations import lightgbm_hook

    return lightgbm_hook.apply(disable=disable)


@_register("catboost")
def _catboost(disable: bool) -> bool:
    from protocol.integrations import catboost_hook

    return catboost_hook.apply(disable=disable)


@_register("pytorch-lightning", "lightning", "pl")
def _lightning(disable: bool) -> bool:
    from protocol.integrations import lightning_hook

    return lightning_hook.apply(disable=disable)


@_register("keras", "tensorflow", "tf")
def _keras(disable: bool) -> bool:
    from protocol.integrations import keras_hook

    return keras_hook.apply(disable=disable)


@_register("torch", "pytorch")
def _torch(disable: bool) -> bool:
    from protocol.integrations import torch_hook

    return torch_hook.apply(disable=disable)


def catalog() -> dict[str, Any]:
    """Names we know about (installed adapters + aliases). For docs / doctor."""
    by_fn: dict[int, list[str]] = {}
    for name, fn in _INSTALLERS.items():
        by_fn.setdefault(id(fn), []).append(name)
    groups = []
    for names in by_fn.values():
        groups.append(sorted(names, key=len))
    return {
        "adapters": available(),
        "aliases": {g[0]: g[1:] for g in groups},
        "active": installed(),
    }
