"""Durable local HTTP API for a checkpoint — try it however you like.

    python -m aquin.serve_api --train . --ckpt last --port 8765
    aq serve --api
    aq serve --api --port 9000 --ckpt last

Endpoints:
  GET  /health
  POST /predict   JSON body: {\"x\": …} or a bare row / rows
  POST /generate  JSON body: {\"prompt\": \"…\", \"max_tokens\"?, \"temperature\"?, \"image\"?}
  GET  /          short help
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def _json_response(handler: BaseHTTPRequestHandler, code: int, body: Any) -> None:
    raw = (json.dumps(body, default=str, indent=2) + "\n").encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(raw)


def _read_json(handler: BaseHTTPRequestHandler) -> Any:
    n = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(n) if n else b"{}"
    if not raw.strip():
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON: {e}") from e


def make_handler(model: Any) -> type[BaseHTTPRequestHandler]:
    caps = {
        "predict": hasattr(model, "predict") and hasattr(model._method, "predict"),
        "generate": hasattr(model._method, "generate"),
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path in ("/", ""):
                _json_response(
                    self,
                    200,
                    {
                        "aq": "serve-api",
                        "endpoints": {
                            "GET /health": "model info",
                            "POST /predict": '{"x": …}',
                            "POST /generate": '{"prompt": "…"}',
                        },
                        "capabilities": caps,
                        "model": repr(model),
                    },
                )
                return
            if path == "/health":
                _json_response(
                    self,
                    200,
                    {
                        "ok": True,
                        "kind": model.kind,
                        "id": model.id,
                        "checkpoint": str(model.checkpoint),
                        "train": str(model.train),
                        "capabilities": caps,
                    },
                )
                return
            _json_response(self, 404, {"error": f"unknown path {path}"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            try:
                body = _read_json(self)
            except ValueError as e:
                _json_response(self, 400, {"error": str(e)})
                return
            try:
                if path == "/predict":
                    if not caps["predict"]:
                        _json_response(
                            self,
                            400,
                            {"error": f"method {model.kind!r} has no predict(); try POST /generate"},
                        )
                        return
                    x = body.get("x", body) if isinstance(body, dict) else body
                    y = model.predict(x)
                    _json_response(self, 200, {"y": y, "id": model.id, "kind": model.kind})
                    return
                if path == "/generate":
                    if not caps["generate"]:
                        _json_response(
                            self,
                            400,
                            {"error": f"method {model.kind!r} has no generate(); try POST /predict"},
                        )
                        return
                    if not isinstance(body, dict):
                        _json_response(self, 400, {"error": "generate needs a JSON object"})
                        return
                    prompt = str(body.get("prompt") or body.get("text") or "")
                    kw: dict[str, Any] = {}
                    if body.get("max_tokens") is not None:
                        kw["max_tokens"] = int(body["max_tokens"])
                    if body.get("temperature") is not None:
                        kw["temperature"] = float(body["temperature"])
                    if body.get("image") is not None:
                        kw["image"] = body["image"]
                    out = model.generate(prompt, **kw)
                    _json_response(self, 200, {"result": out, "id": model.id, "kind": model.kind})
                    return
                _json_response(self, 404, {"error": f"unknown path {path}"})
            except Exception as e:
                _json_response(self, 500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def serve(
    train: str | Path = ".",
    *,
    ckpt: str = "last",
    host: str = "127.0.0.1",
    port: int = 8765,
) -> None:
    from aquin.model import load

    model = load(ckpt, train=train)
    handler = make_handler(model)
    httpd = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{port}"
    print(f"aq serve --api  {url}", flush=True)
    print(f"  model   {model}", flush=True)
    print(f"  health  {url}/health", flush=True)
    print(f"  predict POST {url}/predict   {{\"x\": …}}", flush=True)
    print(f"  generate POST {url}/generate {{\"prompt\": \"…\"}}", flush=True)
    print("  Ctrl-C to stop", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m aquin.serve_api")
    p.add_argument("--train", default=".")
    p.add_argument("--ckpt", default="last")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args(argv)
    serve(args.train, ckpt=args.ckpt, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
