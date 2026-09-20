"""One run record: recipe, data hash, code hash, metrics, pass, artifacts."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from protocol.recipe import load_recipe
from protocol.revision import hash_file, hash_tree
from protocol.paths import art_dir


def recipe_hash(train: Path) -> tuple[str, str]:
    p = train / "recipe.yaml"
    raw = p.read_text(encoding="utf-8")
    return raw, "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def data_hash(train: Path, rec: dict) -> str | None:
    rel = (rec.get("data") or {}).get("path")
    if not rel:
        return None
    src = (train / str(rel)).resolve()
    if not src.exists():
        return None
    rev = train / "data" / "revision.json"
    if rev.is_file():
        try:
            return json.loads(rev.read_text(encoding="utf-8")).get("hash")
        except json.JSONDecodeError:
            pass
    digest, _, _ = hash_tree(src)
    return "sha256:" + digest


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

    rec = load_recipe(train)
    raw, rh = recipe_hash(train)
    rid = aq_metrics.active_run_id()
    if not rid:
        rid = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + rh[-8:]
    arts = dict(extra.get("artifacts") or {})
    for k, v in aq_metrics.take_autolog_artifacts().items():
        arts.setdefault(k, v)
    body = {
        "id": rid,
        "at": datetime.now(timezone.utc).isoformat(),
        "recipe": rec,
        "recipe_hash": rh,
        "data_hash": data_hash(train, rec),
        "code_hash": code_hash(train),
        "tokenizer_hash": arts.get("tokenizer_sha256"),
        "metrics": extra.get("metrics"),
        "pass": extra.get("pass"),
        "artifacts": arts,
    }
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
