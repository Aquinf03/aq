#!/usr/bin/env python3
"""Kernel steps: train, eval, serve, checkpoint. Compose them yourself. aq eval scores and pass/fails."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from methods.linear import load_xy
from protocol.method import call_fit, load_method
from protocol.paths import art_dir, ckpt_dir as _ckpt_dir, evals_dir
from protocol.recipe import load_recipe
from protocol.record import data_hash, recipe_hash, update_last_run, write_run
from protocol import metrics as aq_metrics
from protocol.guard import GuardAbort, assert_no_leak, parse_guard
from protocol.tokenizer import check as check_tokenizer
from protocol.tokenizer import pin as pin_tokenizer

LOWER = {"mse", "rmse", "mae", "loss"}


def ckpt_dir(train: Path) -> Path:
    return _ckpt_dir(train)


def last_ckpt(train: Path) -> Path:
    p = ckpt_dir(train) / "last.json"
    if not p.is_file():
        raise SystemExit("no checkpoint (run aq train)")
    return p


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def probe_files(train: Path, name: str | None = None) -> list[Path]:
    d = evals_dir(train)
    if not d.is_dir():
        return []
    if name:
        for ext in (".csv", ".jsonl"):
            p = d / (name if name.endswith(ext) else name + ext)
            if p.is_file():
                return [p]
        raise SystemExit(f"no eval {name} in {d}")
    out = []
    for p in sorted(d.iterdir()):
        if p.name.startswith("."):
            continue
        if p.is_file() and p.suffix in {".csv", ".jsonl"}:
            out.append(p)
    return out


def data_file(train: Path, rec: dict) -> Path:
    rel = (rec.get("data") or {}).get("path")
    if not rel:
        raise SystemExit("recipe.yaml has no data.path")
    src = (train / str(rel)).resolve()
    method = str(rec.get("method") or "")
    if src.is_dir():
        if method in ("cnn", "vit") or str(rec.get("family") or "") == "vision":
            return src
        raise SystemExit(
            f"data path is a directory (use method: cnn|vit for ImageFolder): {rel}"
        )
    # vlm methods need files (pairs / chat jsonl)
    if method in ("clip", "llava", "flamingo") and not src.is_file():
        raise SystemExit(f"vlm data.path must be a file (jsonl/csv of pairs or chat): {rel}")

    if not src.is_file():
        raise SystemExit(f"data path not found: {rel}")
    return src


def do_train(train: Path, req: dict | None = None) -> list[str]:
    from protocol import capture as aq_capture

    rec = load_recipe(train)
    method = rec["method"]
    src = data_file(train, rec)
    _, rh = recipe_hash(train)
    dh = data_hash(train, rec)
    gcfg = parse_guard(rec)
    aq_metrics.begin(
        train,
        op="train",
        recipe=rec,
        family=rec.get("family"),
        method=method,
        recipe_hash=rh,
        data_hash=dh,
        data_path=str((rec.get("data") or {}).get("path") or ""),
    )
    try:
        from protocol import sysmetrics
        from protocol import grads as aq_grads

        if sysmetrics.want(rec, req):
            sysmetrics.start(interval=2.0)
        if aq_grads.want(rec, req):
            aq_grads.enable(rec, req)
        code_meta, env_meta = aq_capture.maybe_capture(train, rec, req)
        if code_meta:
            aq_metrics.event(
                "code",
                tree=code_meta.get("tree"),
                sha256=code_meta.get("sha256"),
                n_files=code_meta.get("n_files"),
                bytes=code_meta.get("bytes"),
            )
        if env_meta:
            aq_metrics.event(
                "env",
                mode=env_meta.get("mode"),
                requirements=env_meta.get("requirements"),
                archive=env_meta.get("archive"),
                n_packages=env_meta.get("n_packages"),
                bytes=env_meta.get("bytes"),
                python_version=env_meta.get("python_version"),
            )
        if gcfg.get("leak"):
            assert_no_leak(train, rec)
            aq_metrics.event("guard.leak", ok=True)
        mod = load_method(train, str(method))
        model = call_fit(mod, src, rec, train=train)
        if not isinstance(model, dict):
            raise SystemExit("fit() must return a dict")
        model.setdefault("kind", str(method))
        if gcfg.get("safety"):
            tl = model.get("train_loss")
            if tl is not None:
                from protocol.guard import SafetyWatch

                # Final snapshot only: NaN / max_loss. Mid-run spikes use patience via metrics.step.
                SafetyWatch(gcfg).check_final(loss=tl)
        tok_hash = pin_tokenizer(train, model)
        dest = ckpt_dir(train)
        n = 1 + sum(1 for p in dest.glob("*.json") if p.name != "last.json")
        named = dest / f"{n}.json"
        slot = dest / str(n)
        from protocol.model_log import assign_model_id, model_block

        mid = assign_model_id(model, weights_dir=slot if slot.is_dir() else None)
        write_json(named, model)
        shutil.copy2(named, dest / "last.json")
        ckpt_rel = "artifacts/checkpoints/" + named.name
        arts = {
            "checkpoint": ckpt_rel,
            "checkpoint_last": "artifacts/checkpoints/last.json",
            "metrics": "artifacts/metrics.jsonl",
            "logged_model": mid,
        }
        if tok_hash:
            arts["tokenizer"] = "artifacts/tokenizer.json"
            arts["tokenizer_sha256"] = tok_hash
        if hasattr(mod, "write_inspect"):
            arts["inspect"] = mod.write_inspect(train, model)
        if code_meta:
            arts["code_tree"] = code_meta["tree"]
            arts["code_manifest"] = code_meta["manifest"]
        if env_meta:
            arts["env_requirements"] = env_meta["requirements"]
            arts["env_python"] = env_meta["python"]
            if env_meta.get("archive"):
                arts["env_archive"] = env_meta["archive"]
            if env_meta.get("manifest"):
                arts["env_manifest"] = env_meta["manifest"]
        summary = aq_metrics.model_summary(model)
        summary.pop("aq_model_id", None)
        from protocol import autolog

        for k, v in list(arts.items()):
            autolog.log_artifact(k, v)
        aq_metrics.bind_model(logged_model=mid, checkpoint=ckpt_rel, data_hash=dh)
        aq_metrics.event(
            "model",
            id=mid,
            checkpoint=ckpt_rel,
            data_hash=dh,
        )
        aq_metrics.end(
            checkpoint=ckpt_rel,
            logged_model=mid,
            data_hash=dh,
            **summary,
        )
        rid = write_run(
            train,
            {
                "artifacts": arts,
                "model": model_block(model_id=mid, checkpoint=ckpt_rel, data_hash=dh),
            },
        )
        from protocol.term_table import render_table

        art_rows = [
            ["checkpoint", ckpt_rel],
            ["model", mid],
            ["last", "artifacts/checkpoints/last.json"],
            ["metrics", "artifacts/metrics.jsonl"],
            ["run", "artifacts/runs/" + rid + ".json"],
        ]
        if arts.get("inspect"):
            art_rows.append(["inspect", arts["inspect"]])
        if arts.get("tokenizer"):
            art_rows.append(["tokenizer", arts["tokenizer"]])
        if arts.get("code_tree"):
            art_rows.append(["code", arts["code_tree"]])
        if arts.get("env_archive"):
            art_rows.append(["env", arts["env_archive"]])
        elif arts.get("env_requirements"):
            art_rows.append(["env", arts["env_requirements"]])
        lines = ["train", render_table(("artifact", "path"), art_rows)]
        if gcfg.get("safety") or gcfg.get("leak"):
            g = []
            if gcfg.get("safety"):
                g.append("safety")
            if gcfg.get("leak"):
                g.append("leak")
            lines.append(render_table(("key", "value"), [("guard", "+".join(g))]))
        return lines
    except GuardAbort as e:
        aq_metrics.event("guard.abort", message=str(e))
        aq_metrics.end(ok=False, aborted=True, error=str(e))
        raise
    except Exception as e:
        try:
            from protocol import infra as aq_infra

            aq_infra.emit_from_error(e)
        except Exception:
            pass
        aq_metrics.event("error", error=str(e))
        aq_metrics.end(ok=False, error=str(e))
        raise


def score(metric: str, y_true: list, y_hat: list) -> float:
    n = len(y_true)
    if n == 0:
        raise SystemExit("empty eval")
    if metric == "accuracy":
        hit = sum(1 for a, b in zip(y_true, y_hat) if str(a) == str(b))
        return hit / n
    yt = [float(v) for v in y_true]
    yh = [float(v) for v in y_hat]
    err = [a - b for a, b in zip(yt, yh)]
    if metric == "mae":
        return sum(abs(e) for e in err) / n
    mse = sum(e * e for e in err) / n
    if metric == "mse":
        return mse
    if metric == "rmse":
        return mse ** 0.5
    if metric == "r2":
        mean = sum(yt) / n
        tot = sum((a - mean) ** 2 for a in yt)
        if tot == 0:
            return 1.0
        return 1.0 - mse * n / tot
    raise SystemExit(f"unknown metric: {metric}")


def _score_file(train: Path, rec: dict, model: dict, src: Path) -> tuple[str, float, int]:
    kind = str(model.get("kind") or rec.get("method") or "linear")
    mod = load_method(train, kind)
    rec2 = {**rec, "_train": str(train.resolve())}
    if hasattr(mod, "evaluate"):
        metric = str((rec.get("eval") or {}).get("metric") or ("loss" if model.get("backend") == "transformers" else "mse"))
        sc, n = mod.evaluate(model, src, rec2)
        return str(metric), sc, n
    if not hasattr(mod, "predict"):
        raise SystemExit(f"method {kind} needs predict() or evaluate()")
    target = (rec.get("data") or {}).get("target")
    if not target:
        raise SystemExit("recipe.yaml has no data.target")
    metric = str((rec.get("eval") or {}).get("metric") or "mse")
    feats, X, y = load_xy(src, str(target))
    if feats != model.get("features"):
        raise SystemExit(f"features do not match data: {src}")
    y_hat = mod.predict(model, X)
    return metric, score(metric, y, y_hat), len(y)


def _file_pass(metric: str, sc: float, min_score) -> bool | None:
    if min_score is None:
        return None
    lo = str(metric) in LOWER
    return sc <= float(min_score) if lo else sc >= float(min_score)


def do_eval(
    train: Path,
    ckpt_name: str | None,
    probe: str | None = None,
    req: dict | None = None,
) -> list[str]:
    from protocol.model_log import id_from_checkpoint
    from protocol import sysmetrics

    rec = load_recipe(train)
    ckpt = ckpt_dir(train) / ckpt_name if ckpt_name else last_ckpt(train)
    if not ckpt.is_file():
        raise SystemExit(f"no checkpoint: {ckpt.name}")
    model = json.loads(ckpt.read_text(encoding="utf-8"))
    pinned = check_tokenizer(train, model)
    if pinned is not None:
        model["tokenizer"] = pinned
    files = probe_files(train, probe)
    if not files:
        files = [data_file(train, rec)]
    min_score = (rec.get("eval") or {}).get("min_score")
    _, rh = recipe_hash(train)
    dh = data_hash(train, rec)
    ckpt_rel = str(ckpt.relative_to(train))
    mid = id_from_checkpoint(ckpt)
    aq_metrics.begin(
        train,
        op="eval",
        recipe=rec,
        family=rec.get("family"),
        method=rec.get("method"),
        recipe_hash=rh,
        checkpoint=ckpt_rel,
        logged_model=mid,
        data_hash=dh,
        min_score=min_score,
    )
    try:
        if sysmetrics.want(rec, req):
            sysmetrics.start(interval=2.0)
        if parse_guard(rec).get("leak"):
            assert_no_leak(train, rec)
            aq_metrics.event("guard.leak", ok=True)
        probes = []
        wsum = 0.0
        ntot = 0
        metric = "mse"
        all_pass: bool | None = True if min_score is not None else None
        for src in files:
            metric, sc, n = _score_file(train, rec, model, src)
            try:
                rel = str(src.relative_to(train))
            except ValueError:
                rel = str(src)
            fp = _file_pass(metric, sc, min_score)
            probes.append({"path": rel, "score": sc, "n": n, "pass": fp})
            aq_metrics.event(
                "eval.probe",
                path=rel,
                metric=metric,
                score=sc,
                n=n,
                **{"pass": fp},
            )
            wsum += sc * n
            ntot += n
            if all_pass is True and fp is False:
                all_pass = False
        if ntot == 0:
            raise SystemExit("empty eval")
        sc = wsum / ntot
        verdict = "skip" if min_score is None else ("pass" if all_pass else "fail")
        out = {
            "metric": metric,
            "score": sc,
            "n": ntot,
            "pass": all_pass,
            "min_score": min_score,
            "checkpoint": ckpt_rel,
            "logged_model": mid,
            "probes": probes,
        }
        write_json(art_dir(train) /  "eval.json", out)
        aq_metrics.end(
            metric=metric,
            score=sc,
            n=ntot,
            verdict=verdict,
            checkpoint=ckpt_rel,
            logged_model=mid,
            data_hash=dh,
            probes=probes,
            **{"pass": all_pass},
        )
        rid = update_last_run(
            train,
            {
                "metrics": {
                    "metric": metric,
                    "score": sc,
                    "n": ntot,
                    "probes": probes,
                    **({"logged_model": mid, "checkpoint": ckpt_rel} if mid else {"checkpoint": ckpt_rel}),
                },
                "pass": all_pass,
                "artifacts": {
                    "eval": "artifacts/eval.json",
                    "checkpoint": ckpt_rel,
                    "metrics": "artifacts/metrics.jsonl",
                    **({"logged_model": mid} if mid else {}),
                },
            },
        )
        lines = [
            "eval",
            "  " + str(out["metric"]),
            "  " + str(sc),
            "  " + verdict,
            "  " + out["checkpoint"],
            "  artifacts/metrics.jsonl",
            "  artifacts/runs/" + rid + ".json",
        ]
        if len(probes) > 1 or (probes and probes[0]["path"].startswith("evals/")):
            for p in probes:
                lines.append("  " + p["path"] + "  " + str(p["score"]))
        return lines
    except GuardAbort as e:
        aq_metrics.event("guard.abort", message=str(e))
        aq_metrics.end(ok=False, aborted=True, error=str(e))
        raise
    except Exception as e:
        try:
            from protocol import infra as aq_infra

            aq_infra.emit_from_error(e)
        except Exception:
            pass
        aq_metrics.event("error", error=str(e))
        aq_metrics.end(ok=False, error=str(e))
        raise


def do_serve(
    train: Path,
    ckpt_name: str | None,
    prompt: str | None,
    max_tokens: int | None,
    temperature: float | None,
    image: str | None = None,
) -> list[str]:
    from protocol.model_log import id_from_checkpoint

    rec = load_recipe(train)
    ckpt = ckpt_dir(train) / ckpt_name if ckpt_name else last_ckpt(train)
    if not ckpt.is_file():
        raise SystemExit(f"no checkpoint: {ckpt.name}")
    model = json.loads(ckpt.read_text(encoding="utf-8"))
    pinned = check_tokenizer(train, model)
    if pinned is not None:
        model["tokenizer"] = pinned
    serve = rec.get("serve") if isinstance(rec.get("serve"), dict) else {}
    if not prompt:
        prompt = serve.get("prompt")
    # vision / clip may serve with only --image / serve.image
    if not prompt and not image and not (serve.get("image") or serve.get("img") or serve.get("path")):
        if not serve.get("features"):
            raise SystemExit(
                "serve needs a prompt (argv or recipe serve.prompt), "
                "and/or --image / serve.image, or serve.features for tabular"
            )
    kind = str(model.get("kind") or rec.get("method") or "linear")
    ckpt_rel = str(ckpt.relative_to(train))
    mid = id_from_checkpoint(ckpt)
    dh = data_hash(train, rec)
    aq_metrics.begin(
        train,
        op="serve",
        method=kind,
        checkpoint=ckpt_rel,
        logged_model=mid,
        data_hash=dh,
        max_tokens=max_tokens,
        temperature=temperature,
        prompt_chars=len(str(prompt or "")),
        has_image=bool(image or serve.get("image") or serve.get("img")),
    )
    try:
        mod = load_method(train, kind)
        if not hasattr(mod, "generate"):
            raise SystemExit(
                f"method {kind} has no generate() — every built-in should. "
                "If this is a custom tools/method, add generate(model, prompt, rec, ...)."
            )
        rec2 = {**rec, "_train": str(train.resolve())}
        if image:
            rec2 = {**rec2, "_serve_image": str(image)}
        out = mod.generate(model, str(prompt or ""), rec2, max_tokens=max_tokens, temperature=temperature)
        out["checkpoint"] = ckpt_rel
        if mid:
            out["logged_model"] = mid
        write_json(art_dir(train) /  "serve.json", out)
        aq_metrics.end(
            checkpoint=ckpt_rel,
            logged_model=mid,
            data_hash=dh,
            tokens=out.get("tokens"),
            text_chars=len(str(out.get("text") or "")),
            completion_chars=len(str(out.get("completion") or "")),
        )
        rid = update_last_run(
            train,
            {
                "artifacts": {
                    "serve": "artifacts/serve.json",
                    "checkpoint": ckpt_rel,
                    "metrics": "artifacts/metrics.jsonl",
                    **({"logged_model": mid} if mid else {}),
                },
            },
        )
        lines = [
            "serve",
            "  " + str(out.get("text") or ""),
            "  " + out["checkpoint"],
            "  artifacts/serve.json",
            "  artifacts/metrics.jsonl",
            "  artifacts/runs/" + rid + ".json",
        ]
        if out.get("completion") not in (None, "", out.get("text")):
            lines.append("  completion: " + str(out.get("completion")))
        if out.get("label") not in (None, ""):
            lines.append("  label: " + str(out.get("label")))
        if out.get("score") is not None:
            lines.append("  score: " + str(out.get("score")))
        if out.get("tokens") is not None:
            lines.append("  tokens: " + str(out.get("tokens")))
        return lines
    except Exception as e:
        try:
            from protocol import infra as aq_infra

            aq_infra.emit_from_error(e)
        except Exception:
            pass
        aq_metrics.event("error", error=str(e))
        aq_metrics.end(ok=False, error=str(e))
        raise


def do_checkpoint(train: Path, keep: str | None) -> list[str]:
    dest = ckpt_dir(train)
    if keep:
        src = last_ckpt(train)
        name = keep if keep.endswith(".json") else keep + ".json"
        shutil.copy2(src, dest / name)
        return ["checkpoint", "  artifacts/checkpoints/" + name]
    names = sorted(p.name for p in dest.glob("*.json"))
    lines = ["checkpoint"]
    if not names:
        lines.append("  (none)")
        return lines
    for n in names:
        lines.append("  " + n)
    return lines
