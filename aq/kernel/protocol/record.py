"""One run record: recipe, data hash, code hash, metrics, pass, artifacts."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from protocol.recipe import load_recipe
from protocol.revision import data_identity, hash_file
from protocol.paths import art_dir


def recipe_hash(train: Path) -> tuple[str, str]:
    p = train / "recipe.yaml"
    raw = p.read_text(encoding="utf-8")
    return raw, "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def data_hash(train: Path, rec: dict) -> str | None:
    """Back-compat: sha string only. Prefer data_identity() for the rich block."""
    ident = data_identity(train, rec, refresh=False)
    if not ident:
        return None
    h = ident.get("hash")
    return str(h) if h else None


def code_hash(train: Path) -> str:
    """Hash kernel code that affects fit (protocol, backends, methods, engine) + train files."""
    h = hashlib.sha256()
    kernel_root = Path(__file__).resolve().parent.parent
    for sub in ("protocol", "backends", "methods", "engine"):
        base = kernel_root / sub
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*.py")):
            digest, _ = hash_file(f)
            h.update(str(f.relative_to(kernel_root)).encode())
            h.update(digest.encode())
    for rel in ("recipe.yaml",):
        p = train / rel
        if p.is_file():
            digest, _ = hash_file(p)
            h.update(rel.encode())
            h.update(digest.encode())
    tools = train / "tools"
    if tools.is_dir():
        for f in sorted(tools.rglob("*")):
            if not f.is_file() or f.name.startswith("."):
                continue
            digest, _ = hash_file(f)
            h.update(str(f.relative_to(train)).encode())
            h.update(digest.encode())
    return "sha256:" + h.hexdigest()


def runs_dir(train: Path) -> Path:
    d = art_dir(train) /  "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_summary(d: Path, body: dict) -> None:
    rec = body.get("recipe") or {}
    m = body.get("metrics") or {}
    p = body.get("pass")
    if p is True:
        verdict = "pass"
    elif p is False:
        verdict = "fail"
    else:
        verdict = "skip"
    arts = body.get("artifacts") or {}
    lines = [
        "# " + str(body.get("id") or "run"),
        "",
        "at: " + str(body.get("at") or ""),
        "family: " + str(rec.get("family") or ""),
        "method: " + str(rec.get("method") or ""),
        "recipe: " + str(body.get("recipe_hash") or ""),
        "data: " + str(body.get("data_hash") or "-"),
        "code: " + str(body.get("code_hash") or ""),
        "tokenizer: " + str(body.get("tokenizer_hash") or arts.get("tokenizer_sha256") or "-"),
        "metric: " + str(m.get("metric") or "-"),
        "score: " + str(m.get("score") if m.get("score") is not None else "-"),
        "verdict: " + verdict,
    ]
    data = body.get("data") or {}
    if isinstance(data, dict):
        if data.get("n") is not None:
            lines.append("data_n: " + str(data.get("n")))
        if data.get("n_columns") is not None:
            lines.append("data_cols: " + str(data.get("n_columns")))
        if data.get("target"):
            lines.append("data_target: " + str(data.get("target")))
    code = body.get("code") or {}
    if isinstance(code, dict) and code.get("tree"):
        lines.append("code_tree: " + str(code.get("tree")))
        if code.get("sha256"):
            lines.append("code_sha256: " + str(code.get("sha256")))
    env = body.get("env") or {}
    if isinstance(env, dict) and env.get("mode"):
        lines.append("env_mode: " + str(env.get("mode")))
        if env.get("requirements"):
            lines.append("env_requirements: " + str(env.get("requirements")))
        if env.get("archive"):
            lines.append("env_archive: " + str(env.get("archive")))
    tags = body.get("tags") or []
    if tags:
        lines.append("tags: " + ", ".join(str(t) for t in tags))
    notes = body.get("notes")
    if notes:
        lines.append("notes: " + str(notes).replace("\n", " ")[:200])
    params = body.get("params") or {}
    if isinstance(params, dict) and params:
        lines.append("params: " + str(len(params)) + " keys")
    for k, v in arts.items():
        lines.append(str(k) + ": " + str(v))
    lines.append("")
    md = "\n".join(lines)
    rid = body.get("id")
    if rid:
        (d / (str(rid) + ".md")).write_text(md, encoding="utf-8")
    (d / "last.md").write_text(md, encoding="utf-8")


def write_run(train: Path, extra: dict) -> str:
    from protocol import metrics as aq_metrics
    from protocol import capture as aq_capture

    rec = load_recipe(train)
    raw, rh = recipe_hash(train)
    rid = aq_metrics.active_run_id()
    if not rid:
        rid = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + rh[-8:]
    arts = dict(extra.get("artifacts") or {})
    for k, v in aq_metrics.take_autolog_artifacts().items():
        arts.setdefault(k, v)
    code_meta = aq_capture.take_code_meta()
    if code_meta:
        arts.setdefault("code_tree", code_meta.get("tree"))
        arts.setdefault("code_manifest", code_meta.get("manifest"))
    env_meta = aq_capture.take_env_meta()
    if env_meta:
        arts.setdefault("env_requirements", env_meta.get("requirements"))
        arts.setdefault("env_python", env_meta.get("python"))
        if env_meta.get("archive"):
            arts.setdefault("env_archive", env_meta.get("archive"))
        if env_meta.get("manifest"):
            arts.setdefault("env_manifest", env_meta.get("manifest"))
    data_meta = data_identity(train, rec, refresh=False)
    body = {
        "id": rid,
        "at": datetime.now(timezone.utc).isoformat(),
        "recipe": rec,
        "recipe_hash": rh,
        "data_hash": (data_meta or {}).get("hash"),
        "code_hash": code_hash(train),
        "tokenizer_hash": arts.get("tokenizer_sha256"),
        "metrics": extra.get("metrics"),
        "pass": extra.get("pass"),
        "artifacts": arts,
    }
    if data_meta:
        body["data"] = data_meta
    if code_meta:
        body["code"] = code_meta
    if env_meta:
        body["env"] = env_meta
    from protocol import runlog

    meta = runlog.snapshot()
    if meta.get("tags"):
        body["tags"] = meta["tags"]
    if meta.get("notes") is not None:
        body["notes"] = meta["notes"]
    if meta.get("params"):
        body["params"] = meta["params"]
    d = runs_dir(train)
    path = d / (rid + ".json")
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    (d / "last.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    write_summary(d, body)
    return rid


def update_last_run(train: Path, extra: dict) -> str:
    from protocol import metrics as aq_metrics

    last = runs_dir(train) / "last.json"
    if not last.is_file():
        return write_run(train, extra)
    body = json.loads(last.read_text(encoding="utf-8"))
    if extra.get("metrics") is not None:
        body["metrics"] = extra["metrics"]
    if "pass" in extra:
        body["pass"] = extra["pass"]
    arts = dict(body.get("artifacts") or {})
    arts.update(extra.get("artifacts") or {})
    for k, v in aq_metrics.take_autolog_artifacts().items():
        arts.setdefault(k, v)
    body["artifacts"] = arts
    last.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    rid = body.get("id")
    d = runs_dir(train)
    if rid:
        (d / (str(rid) + ".json")).write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    write_summary(d, body)
    return str(rid)
