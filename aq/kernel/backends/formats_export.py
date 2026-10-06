"""Post-train weight format exporters (GGUF / GPTQ / AWQ / EXL2).

Real converters only. Missing optional deps → clear install error, never a fake file.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from backends.device import device_kind
from backends.recipe_opt import opt


def formats_requested(rec: dict) -> list[str]:
    """Normalize recipe formats → list of exporter names."""
    raw = opt(rec, "formats", None, "deploy", "llm")
    if raw is None or raw is False:
        return []
    if raw is True:
        return ["gguf", "gptq", "awq", "exl2"]
    if isinstance(raw, str):
        return [raw.lower().strip()]
    if isinstance(raw, (list, tuple)):
        out = []
        for x in raw:
            if isinstance(x, str) and x.strip():
                out.append(x.lower().strip())
        return out
    if isinstance(raw, dict):
        # formats: { gguf: q8_0, gptq: true }
        out = []
        for k, v in raw.items():
            if v is False or v is None:
                continue
            out.append(str(k).lower().strip())
        return out
    raise SystemExit(f"recipe formats: unsupported value {raw!r}")


def export_formats(model, tok, slot: Path, rec: dict, manifest: dict) -> dict:
    """Write requested weight packs under slot/formats/. Updates deploy + manifest."""
    wanted = formats_requested(rec)
    if not wanted:
        return {}

    train = Path(rec["_train"])
    out_root = slot / "formats"
    out_root.mkdir(parents=True, exist_ok=True)

    hf_dir = _prepare_hf_dir(model, tok, out_root / "hf", rec)
    results: dict[str, Any] = {"hf": {"path": str(hf_dir.relative_to(train))}}
    errors: list[str] = []
    exported: list[str] = []

    for name in wanted:
        try:
            if name == "gguf":
                meta = _export_gguf(hf_dir, out_root / "gguf", rec, tok)
            elif name == "gptq":
                meta = _export_gptq(hf_dir, out_root / "gptq", rec, tok)
            elif name == "awq":
                meta = _export_awq(hf_dir, out_root / "awq", rec, tok)
            elif name in ("exl2", "exllamav2"):
                meta = _export_exl2(hf_dir, out_root / "exl2", rec)
            elif name == "hf":
                meta = {"path": str(hf_dir.relative_to(train)), "note": "merged Hugging Face weights"}
            else:
                raise SystemExit(
                    f"unknown format {name!r}. Supported: gguf, gptq, awq, exl2, hf"
                )
            if "path" in meta and not str(meta["path"]).startswith(str(train)):
                # keep relative when possible
                p = Path(meta["path"])
                if p.is_absolute():
                    try:
                        meta["path"] = str(p.relative_to(train))
                    except ValueError:
                        pass
            results[name] = meta
            exported.append(name)
            print(f"  formats  {name} → {meta.get('path', meta)}", file=sys.stderr)
        except SystemExit as e:
            if len(wanted) == 1:
                raise
            errors.append(f"{name}: {e}")
            print(f"  formats  skip {name}: {e}", file=sys.stderr)

    # formats: true tries several — need at least one real pack beyond the HF merge
    real = [x for x in exported if x != "hf"]
    if not real and wanted != ["hf"]:
        detail = "\n".join(f"  - {e}" for e in errors) or "  (no exporters ran)"
        raise SystemExit(
            "recipe formats: could not export any weight pack.\n"
            f"{detail}\n"
            "Fix: install an exporter (see aq kernel README) or set formats: [hf] "
            "for merged Hugging Face weights only."
        )

    results["exported"] = exported
    if errors:
        results["skipped"] = errors
    (out_root / "formats.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return results


def _prepare_hf_dir(model, tok, dest: Path, rec: dict) -> Path:
    """Save a full causal-LM directory (merge LoRA/PEFT when needed)."""
    dest.mkdir(parents=True, exist_ok=True)
    m = model
    if hasattr(m, "inner"):
        m = m.inner
    # PEFT / LoRA
    if hasattr(m, "merge_and_unload"):
        print("  formats  merging LoRA adapters into base weights…", file=sys.stderr)
        try:
            m = m.merge_and_unload()
        except Exception as e:
            raise SystemExit(
                f"could not merge LoRA for formats export: {e}\n"
                "Fix: train without bits: 4 (full LoRA merge), or export from a full-ft checkpoint."
            ) from e
    elif hasattr(m, "merge_adapter"):
        m.merge_adapter()

    m.save_pretrained(str(dest))
    tok.save_pretrained(str(dest))
    return dest


def _gguf_outtype(rec: dict) -> str:
    raw = opt(rec, "formats", None, "deploy", "llm")
    if isinstance(raw, dict) and raw.get("gguf"):
        v = raw["gguf"]
        if isinstance(v, str) and v.strip():
            return v.strip().lower()
    t = opt(rec, "gguf_type", None, "deploy", "llm") or opt(rec, "outtype", None, "deploy", "llm")
    if t:
        return str(t).lower()
    return "f16"


def _export_gguf(hf_dir: Path, out_dir: Path, rec: dict, tok) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    outtype = _gguf_outtype(rec)
    outfile = out_dir / f"model-{outtype}.gguf"

    script = _find_convert_hf_to_gguf()
    if script is not None:
        cmd = [
            sys.executable,
            str(script),
            str(hf_dir),
            "--outfile",
            str(outfile),
            "--outtype",
            outtype,
        ]
        print(f"  formats  gguf via {script}", file=sys.stderr)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not outfile.is_file():
            err = (proc.stderr or proc.stdout or "").strip()[-2000:]
            raise SystemExit(f"convert_hf_to_gguf failed:\n{err}")
        return {
            "path": str(outfile),
            "outtype": outtype,
            "tool": "llama.cpp convert_hf_to_gguf.py",
            "bytes": outfile.stat().st_size,
        }

    # Built-in Llama-family F16/BF16/F32 writer (no llama.cpp required)
    if outtype not in ("f16", "fp16", "float16", "bf16", "f32", "fp32", "float32"):
        raise SystemExit(
            f"gguf outtype {outtype!r} needs llama.cpp quantize "
            "(set AQUIN_LLAMA_CPP to a llama.cpp checkout). "
            "Built-in exporter supports f16 / bf16 / f32 only.\n"
            "Fix: gguf_type: f16   or   install llama.cpp and export again."
        )
    return _write_gguf_llama_family(hf_dir, outfile, outtype, tok)


def _find_convert_hf_to_gguf() -> Path | None:
    env = os.environ.get("AQUIN_LLAMA_CPP", "").strip()
    candidates: list[Path] = []
    if env:
        root = Path(env)
        candidates += [
            root / "convert_hf_to_gguf.py",
            root / "convert-hf-to-gguf.py",
            root,
        ]
    home = Path.home() / ".axi" / "tools" / "llama.cpp"
    legacy = Path.home() / ".aq" / "tools" / "llama.cpp"
    candidates += [
        home / "convert_hf_to_gguf.py",
        legacy / "convert_hf_to_gguf.py",
        Path("/usr/local/share/llama.cpp/convert_hf_to_gguf.py"),
    ]
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        candidates.append(Path(which))
    for p in candidates:
        if p.is_file() and p.name.endswith(".py"):
            return p
    return None


def _write_gguf_llama_family(hf_dir: Path, outfile: Path, outtype: str, tok) -> dict:
    try:
        import gguf
        import torch
        from transformers import AutoConfig, AutoModelForCausalLM
    except ImportError as e:
        raise SystemExit(
            "gguf export needs the gguf package (and torch/transformers).\n"
            "Fix: pip install gguf   in the kernel venv, or set AQUIN_LLAMA_CPP."
        ) from e

    cfg = AutoConfig.from_pretrained(str(hf_dir), trust_remote_code=True)
    model_type = str(getattr(cfg, "model_type", "") or "").lower()
    arch = _gguf_arch(model_type)
    if arch is None:
        raise SystemExit(
            f"built-in GGUF writer does not support model_type={model_type!r}.\n"
            "Fix: set AQUIN_LLAMA_CPP=/path/to/llama.cpp for full convert_hf_to_gguf.py, "
            "or use formats: [hf]."
        )

    dtype = {
        "f16": torch.float16,
        "fp16": torch.float16,
        "float16": torch.float16,
        "bf16": torch.bfloat16,
        "f32": torch.float32,
        "fp32": torch.float32,
        "float32": torch.float32,
    }[outtype]

    print(f"  formats  loading HF weights for GGUF ({arch})…", file=sys.stderr)
    model = AutoModelForCausalLM.from_pretrained(
        str(hf_dir), trust_remote_code=True, torch_dtype=dtype
    )
    model.eval()

    writer = gguf.GGUFWriter(str(outfile), arch)
    _add_llama_metadata(writer, cfg, arch, tok)
    _add_tokenizer(writer, tok, gguf)

    sd = model.state_dict()
    mapped = 0
    for name, tensor in sd.items():
        gguf_name = _map_tensor_name(name, arch)
        if gguf_name is None:
            continue
        data = tensor.detach().to(dtype).cpu().numpy()
        writer.add_tensor(gguf_name, data)
        mapped += 1

    if mapped < 8:
        raise SystemExit(
            f"GGUF mapping produced only {mapped} tensors for {model_type!r} — "
            "refusing to write a broken file. Use AQUIN_LLAMA_CPP or formats: [hf]."
        )

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    del model
    return {
        "path": str(outfile),
        "outtype": outtype,
        "arch": arch,
        "model_type": model_type,
        "tensors": mapped,
        "tool": "aq built-in gguf writer",
        "bytes": outfile.stat().st_size,
    }


def _gguf_arch(model_type: str) -> str | None:
    if model_type in ("llama", "mistral", "mixtral", "phi3", "phi", "qwen2", "qwen2_moe"):
        # qwen2 uses its own arch name in modern gguf
        if model_type.startswith("qwen2"):
            return "qwen2"
        if model_type in ("phi3", "phi"):
            return "phi3"
        return "llama"
    if model_type in ("gemma", "gemma2"):
        return "gemma" if model_type == "gemma" else "gemma2"
    return None


def _add_llama_metadata(writer, cfg, arch: str, tok) -> None:
    n_layer = int(getattr(cfg, "num_hidden_layers", 0) or 0)
    n_embd = int(getattr(cfg, "hidden_size", 0) or 0)
    n_ff = int(getattr(cfg, "intermediate_size", 0) or 0)
    n_head = int(getattr(cfg, "num_attention_heads", 0) or 0)
    n_kv = int(getattr(cfg, "num_key_value_heads", n_head) or n_head)
    ctx = int(getattr(cfg, "max_position_embeddings", 0) or 0)
    eps = float(getattr(cfg, "rms_norm_eps", 1e-5) or 1e-5)
    rope = float(getattr(cfg, "rope_theta", 10000.0) or 10000.0)
    vocab = int(getattr(cfg, "vocab_size", getattr(tok, "vocab_size", 0)) or 0)

    writer.add_name(getattr(cfg, "_name_or_path", arch) or arch)
    writer.add_context_length(ctx)
    writer.add_embedding_length(n_embd)
    writer.add_block_count(n_layer)
    writer.add_feed_forward_length(n_ff)
    writer.add_head_count(n_head)
    writer.add_head_count_kv(n_kv)
    writer.add_layer_norm_rms_eps(eps)
    writer.add_vocab_size(vocab)
    if hasattr(writer, "add_rope_freq_base"):
        writer.add_rope_freq_base(rope)


def _add_tokenizer(writer, tok, gguf_mod) -> None:
    """Best-effort tokenizer dump so llama.cpp can load the GGUF alone."""
    try:
        vocab_size = int(getattr(tok, "vocab_size", 0) or len(tok))
        tokens: list[bytes] = []
        scores: list[float] = []
        toktypes: list[int] = []
        for i in range(vocab_size):
            try:
                piece = tok.convert_ids_to_tokens(i)
            except Exception:
                piece = f"<{i}>"
            if piece is None:
                piece = f"<{i}>"
            if isinstance(piece, bytes):
                raw = piece
            else:
                s = str(piece)
                # SentencePiece-style space marker
                s = s.replace("▁", " ").replace("Ġ", " ")
                raw = s.encode("utf-8", errors="replace")
            tokens.append(raw)
            scores.append(0.0)
            toktypes.append(int(gguf_mod.TokenType.NORMAL))
        writer.add_tokenizer_model("llama")
        writer.add_token_list(tokens)
        writer.add_token_scores(scores)
        writer.add_token_types(toktypes)
        if tok.bos_token_id is not None:
            writer.add_bos_token_id(int(tok.bos_token_id))
        if tok.eos_token_id is not None:
            writer.add_eos_token_id(int(tok.eos_token_id))
        if tok.pad_token_id is not None:
            writer.add_pad_token_id(int(tok.pad_token_id))
        if tok.unk_token_id is not None and hasattr(writer, "add_unk_token_id"):
            writer.add_unk_token_id(int(tok.unk_token_id))
    except Exception as e:
        print(f"  formats  tokenizer metadata incomplete: {e}", file=sys.stderr)


def _map_tensor_name(hf_name: str, arch: str) -> str | None:
    """Map HF causal-LM tensor names → GGUF names (llama / qwen2 / phi3 / gemma family)."""
    name = hf_name
    if name.startswith("model."):
        name = name[len("model.") :]

    # embeddings / output
    if name in ("embed_tokens.weight",):
        return "token_embd.weight"
    if name in ("norm.weight",):
        return "output_norm.weight"
    if name in ("lm_head.weight",):
        return "output.weight"

    # layers
    if not name.startswith("layers."):
        return None
    rest = name[len("layers.") :]
    try:
        idx_s, rem = rest.split(".", 1)
        i = int(idx_s)
    except ValueError:
        return None

    mapping = {
        "input_layernorm.weight": f"blk.{i}.attn_norm.weight",
        "post_attention_layernorm.weight": f"blk.{i}.ffn_norm.weight",
        "self_attn.q_proj.weight": f"blk.{i}.attn_q.weight",
        "self_attn.k_proj.weight": f"blk.{i}.attn_k.weight",
        "self_attn.v_proj.weight": f"blk.{i}.attn_v.weight",
        "self_attn.o_proj.weight": f"blk.{i}.attn_output.weight",
        "mlp.gate_proj.weight": f"blk.{i}.ffn_gate.weight",
        "mlp.up_proj.weight": f"blk.{i}.ffn_up.weight",
        "mlp.down_proj.weight": f"blk.{i}.ffn_down.weight",
        # gemma / some variants
        "mlp.gate_proj.bias": f"blk.{i}.ffn_gate.bias",
        "self_attn.q_proj.bias": f"blk.{i}.attn_q.bias",
        "self_attn.k_proj.bias": f"blk.{i}.attn_k.bias",
        "self_attn.v_proj.bias": f"blk.{i}.attn_v.bias",
    }
    return mapping.get(rem)


def _calibration_texts(rec: dict, n: int = 64) -> list[str]:
    """Small text list for GPTQ/AWQ calibration from recipe data when possible."""
    train = Path(rec.get("_train") or ".")
    data = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    path = data.get("path") or opt(rec, "path", None, "data")
    texts: list[str] = []
    if path:
        p = Path(path)
        if not p.is_file():
            p = train / path
        if p.is_file():
            try:
                if p.suffix.lower() == ".jsonl":
                    for line in p.read_text(encoding="utf-8").splitlines():
                        if not line.strip():
                            continue
                        row = json.loads(line)
                        t = row.get("text") or row.get("prompt") or row.get("completion")
                        if t:
                            texts.append(str(t))
                        if len(texts) >= n:
                            break
                else:
                    # plain / csv-ish: first column-ish lines
                    for line in p.read_text(encoding="utf-8").splitlines()[1:]:
                        if line.strip():
                            texts.append(line.strip()[:512])
                        if len(texts) >= n:
                            break
            except Exception:
                pass
    if not texts:
        texts = [
            "The quick brown fox jumps over the lazy dog.",
            "Machine learning models need careful evaluation.",
            "Speculative decoding uses a draft model for speed.",
        ] * max(1, n // 3)
    return texts[:n]


def _export_gptq(hf_dir: Path, out_dir: Path, rec: dict, tok) -> dict:
    if device_kind() not in ("cuda", "rocm"):
        raise SystemExit("GPTQ export needs CUDA (or ROCm). Use formats: [gguf] on this machine.")
    try:
        from transformers import AutoModelForCausalLM, GPTQConfig
    except ImportError as e:
        raise SystemExit(
            "GPTQ needs a recent transformers with GPTQConfig.\n"
            "Fix: pip install -U transformers optimum auto-gptq"
        ) from e

    bits = int(opt(rec, "gptq_bits", 4, "deploy", "llm") or 4)
    texts = _calibration_texts(rec)
    print(f"  formats  GPTQ {bits}-bit (n_calib={len(texts)})…", file=sys.stderr)
    qcfg = GPTQConfig(
        bits=bits,
        dataset=texts,
        tokenizer=tok,
        desc_act=bool(opt(rec, "desc_act", False, "deploy", "llm")),
    )
    try:
        model = AutoModelForCausalLM.from_pretrained(
            str(hf_dir),
            quantization_config=qcfg,
            device_map="auto",
            trust_remote_code=True,
        )
    except Exception as e:
        raise SystemExit(
            f"GPTQ quantize failed: {e}\n"
            "Fix: pip install optimum auto-gptq   (CUDA), or remove gptq from formats."
        ) from e
    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out_dir))
    tok.save_pretrained(str(out_dir))
    return {
        "path": str(out_dir),
        "bits": bits,
        "tool": "transformers GPTQConfig",
    }


def _export_awq(hf_dir: Path, out_dir: Path, rec: dict, tok) -> dict:
    if device_kind() not in ("cuda", "rocm"):
        raise SystemExit("AWQ export needs CUDA (or ROCm). Use formats: [gguf] on this machine.")
    try:
        from awq import AutoAWQForCausalLM
    except ImportError as e:
        raise SystemExit(
            "AWQ needs autoawq.\nFix: pip install autoawq   (CUDA), or remove awq from formats."
        ) from e

    bits = int(opt(rec, "awq_bits", 4, "deploy", "llm") or 4)
    group = int(opt(rec, "awq_group_size", 128, "deploy", "llm") or 128)
    texts = _calibration_texts(rec, n=32)
    calib = [{"text": t} for t in texts]
    print(f"  formats  AWQ {bits}-bit…", file=sys.stderr)
    try:
        model = AutoAWQForCausalLM.from_pretrained(str(hf_dir), trust_remote_code=True)
        model.quantize(
            tok,
            quant_config={"zero_point": True, "q_group_size": group, "w_bit": bits, "version": "GEMM"},
            calib_data=calib,
        )
    except Exception as e:
        raise SystemExit(f"AWQ quantize failed: {e}") from e
    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_quantized(str(out_dir))
    tok.save_pretrained(str(out_dir))
    return {
        "path": str(out_dir),
        "bits": bits,
        "group_size": group,
        "tool": "autoawq",
    }


def _export_exl2(hf_dir: Path, out_dir: Path, rec: dict) -> dict:
    convert = os.environ.get("AQUIN_EXL2_CONVERT", "").strip()
    candidates = []
    if convert:
        candidates.append(Path(convert))
    which = shutil.which("convert.py")
    if which:
        candidates.append(Path(which))
    home = Path.home() / ".axi" / "tools" / "exllamav2" / "convert.py"
    if home.is_file():
        candidates.append(home)
    legacy = Path.home() / ".aq" / "tools" / "exllamav2" / "convert.py"
    if legacy.is_file():
        candidates.append(legacy)

    script = next((p for p in candidates if p.is_file()), None)
    if script is None:
        raise SystemExit(
            "EXL2 needs exllamav2's convert.py.\n"
            "Fix: set AQUIN_EXL2_CONVERT=/path/to/exllamav2/convert.py, "
            "or remove exl2 from formats."
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    bpw = opt(rec, "exl2_bpw", 4.625, "deploy", "llm")
    cmd = [
        sys.executable,
        str(script),
        "-i",
        str(hf_dir),
        "-o",
        str(out_dir),
        "-b",
        str(bpw),
    ]
    print(f"  formats  EXL2 via {script}", file=sys.stderr)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise SystemExit(f"EXL2 convert failed:\n{err}")
    return {
        "path": str(out_dir),
        "bpw": float(bpw) if bpw is not None else None,
        "tool": "exllamav2 convert.py",
    }
