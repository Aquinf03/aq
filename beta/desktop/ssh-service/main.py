"""
Aquin desktop SSH service — AsyncSSH over newline-delimited JSON-RPC on stdio.

Methods:
  ping
  shutdown
  ssh.connect
  ssh.disconnect
  ssh.listdir
  ssh.exec
  ssh.read_file
  ssh.write_file
  ssh.bootstrap
  ssh.forward_local  (local port → remote host:port)
  ssh.forward_close
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any

import asyncssh


@dataclass
class Connection:
    conn: asyncssh.SSHClientConnection
    host: str
    username: str
    port: int
    forwards: dict[str, Any] = field(default_factory=dict)


CONNECTIONS: dict[str, Connection] = {}


def reply(msg_id: str | None, *, result: Any = None, error: str | None = None) -> None:
    payload: dict[str, Any] = {"id": msg_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def handle(method: str, params: dict[str, Any]) -> Any:
    if method == "ping":
        return {"ok": True, "service": "aquin-ssh", "asyncssh": getattr(asyncssh, "__version__", "unknown")}

    if method == "shutdown":
        for cid in list(CONNECTIONS.keys()):
            await _disconnect(cid)
        return {"ok": True}

    if method == "ssh.connect":
        return await _connect(params)

    if method == "ssh.disconnect":
        cid = str(params.get("connectionId") or "")
        await _disconnect(cid)
        return {"ok": True}

    if method == "ssh.listdir":
        return await _listdir(params)

    if method == "ssh.exec":
        return await _exec(params)

    if method == "ssh.read_file":
        return await _read_file(params)

    if method == "ssh.write_file":
        return await _write_file(params)

    if method == "ssh.bootstrap":
        return await _bootstrap(params)

    if method == "ssh.forward_local":
        return await _forward_local(params)

    if method == "ssh.forward_close":
        return await _forward_close(params)

    raise ValueError(f"unknown method: {method}")


async def _connect(params: dict[str, Any]) -> dict[str, Any]:
    host = str(params.get("host") or "").strip()
    username = str(params.get("username") or "").strip()
    port = int(params.get("port") or 22)
    client_keys = params.get("clientKeys") or params.get("privateKeyPath")
    password = params.get("password")
    passphrase = params.get("passphrase")
    known_hosts = params.get("knownHosts")  # None => default; False => skip

    if not host or not username:
        raise ValueError("host and username are required")

    connect_kwargs: dict[str, Any] = {
        "host": host,
        "port": port,
        "username": username,
    }

    if known_hosts is False or known_hosts == "ignore":
        connect_kwargs["known_hosts"] = None
    elif known_hosts:
        connect_kwargs["known_hosts"] = known_hosts

    if client_keys:
        if isinstance(client_keys, str):
            connect_kwargs["client_keys"] = [os.path.expanduser(client_keys)]
        else:
            connect_kwargs["client_keys"] = [os.path.expanduser(str(k)) for k in client_keys]

    if password:
        connect_kwargs["password"] = str(password)
    if passphrase:
        connect_kwargs["passphrase"] = str(passphrase)

    # Prefer agent if no explicit key/password
    if not connect_kwargs.get("client_keys") and not password:
        connect_kwargs["agent_path"] = None  # default agent

    conn = await asyncssh.connect(**connect_kwargs)
    cid = str(uuid.uuid4())
    CONNECTIONS[cid] = Connection(conn=conn, host=host, username=username, port=port)

    # Probe remote for first-time setup signals
    probe = await _probe_remote(conn)
    return {
        "connectionId": cid,
        "host": host,
        "username": username,
        "port": port,
        "probe": probe,
    }


async def _disconnect(cid: str) -> None:
    entry = CONNECTIONS.pop(cid, None)
    if not entry:
        return
    for fwd in list(entry.forwards.values()):
        try:
            fwd.close()
        except Exception:
            pass
    entry.conn.close()
    await entry.conn.wait_closed()


async def _probe_remote(conn: asyncssh.SSHClientConnection) -> dict[str, Any]:
    """Detect whether AQ tooling is present on the remote host."""
    result: dict[str, Any] = {
        "hasAq": False,
        "aqVersion": None,
        "home": None,
        "uname": None,
        "needsBootstrap": True,
    }
    try:
        r = await conn.run("echo $HOME && uname -s && (aq --version 2>/dev/null || aquin --version 2>/dev/null || true)", check=False)
        lines = (r.stdout or "").strip().splitlines()
        if lines:
            result["home"] = lines[0].strip() or None
        if len(lines) > 1:
            result["uname"] = lines[1].strip() or None
        if len(lines) > 2 and lines[2].strip():
            result["hasAq"] = True
            result["aqVersion"] = lines[2].strip()
            result["needsBootstrap"] = False
    except Exception as exc:
        result["error"] = str(exc)
    return result


def _require_conn(params: dict[str, Any]) -> Connection:
    cid = str(params.get("connectionId") or "")
    entry = CONNECTIONS.get(cid)
    if not entry:
        raise ValueError("invalid or disconnected connectionId")
    return entry


async def _listdir(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    remote_path = str(params.get("path") or ".")
    async with entry.conn.start_sftp_client() as sftp:
        names = await sftp.listdir(remote_path)
        entries = []
        for name in sorted(names):
            if name in (".", ".."):
                continue
            full = remote_path.rstrip("/") + "/" + name if remote_path not in (".", "") else name
            try:
                st = await sftp.stat(full)
                is_dir = False
                # Prefer SFTP type attribute when present (1=file, 2=dir).
                st_type = getattr(st, "type", None)
                if st_type is not None:
                    is_dir = int(st_type) == 2
                elif st.permissions is not None:
                    is_dir = bool(st.permissions & 0o040000)
                entries.append(
                    {
                        "name": name,
                        "path": full,
                        "isDir": is_dir,
                        "size": int(st.size) if st.size is not None else None,
                        "mtime": float(st.mtime) if st.mtime is not None else None,
                    }
                )
            except Exception:
                entries.append({"name": name, "path": full, "isDir": False, "size": None, "mtime": None})
    return {"path": remote_path, "entries": entries}


async def _exec(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    command = str(params.get("command") or "")
    if not command:
        raise ValueError("command is required")
    cwd = params.get("cwd")
    if cwd:
        # naive but effective for bootstrap/job probes
        command = f"cd {shlex.quote(str(cwd))} && {command}"
    r = await entry.conn.run(command, check=False)
    return {
        "exitStatus": r.exit_status,
        "stdout": r.stdout or "",
        "stderr": r.stderr or "",
    }


async def _read_file(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    remote_path = str(params.get("path") or "")
    max_bytes = int(params.get("maxBytes") or 2_000_000)
    async with entry.conn.start_sftp_client() as sftp:
        async with sftp.open(remote_path, "rb") as f:
            data = await f.read(max_bytes)
    # Return text when utf-8; else base64
    try:
        text = data.decode("utf-8")
        return {"path": remote_path, "encoding": "utf-8", "content": text}
    except UnicodeDecodeError:
        import base64

        return {
            "path": remote_path,
            "encoding": "base64",
            "content": base64.b64encode(data).decode("ascii"),
        }


async def _write_file(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    remote_path = str(params.get("path") or "")
    content = params.get("content")
    encoding = str(params.get("encoding") or "utf-8")
    if content is None:
        raise ValueError("content is required")
    if encoding == "base64":
        import base64

        data = base64.b64decode(str(content))
    else:
        data = str(content).encode("utf-8")
    async with entry.conn.start_sftp_client() as sftp:
        async with sftp.open(remote_path, "wb") as f:
            await f.write(data)
    return {"ok": True, "path": remote_path, "bytes": len(data)}


async def _bootstrap(params: dict[str, Any]) -> dict[str, Any]:
    """
    First-time server setup: detect missing AQ bits and copy a minimal remote helper.

    Full framework install can still use install.sh; this drops a small marker + probe script
    so the desktop app can tell the machine was claimed by Aquin.
    """
    entry = _require_conn(params)
    probe = await _probe_remote(entry.conn)
    home = probe.get("home") or "~"
    remote_dir = str(params.get("remoteDir") or f"{home}/.aquin")
    steps: list[dict[str, Any]] = []

    # Ensure directory
    r = await entry.conn.run(f"mkdir -p {shlex.quote(remote_dir)}", check=False)
    steps.append({"step": "mkdir", "exitStatus": r.exit_status, "stderr": r.stderr or ""})

    marker = (
        "# Managed by Aquin desktop\n"
        f"host={entry.host}\n"
        "role=compute\n"
    )
    async with entry.conn.start_sftp_client() as sftp:
        marker_path = remote_dir.rstrip("/") + "/BOOTSTRAPPED"
        async with sftp.open(marker_path, "w") as f:
            await f.write(marker)
        steps.append({"step": "write_marker", "path": marker_path})

        helper = remote_dir.rstrip("/") + "/remote_info.sh"
        script = "#!/usr/bin/env bash\nset -euo pipefail\necho aquin-remote\nuname -a\ncommand -v aq || true\ncommand -v python3 || true\n"
        async with sftp.open(helper, "w") as f:
            await f.write(script)
        await sftp.chmod(helper, 0o755)
        steps.append({"step": "write_helper", "path": helper})

    # Optional: run install snippet if requested
    if params.get("installAq"):
        install_cmd = str(
            params.get("installCommand")
            or "curl -fsSL https://aq.aquin.app/framework/install.sh | bash"
        )
        r2 = await entry.conn.run(install_cmd, check=False)
        steps.append(
            {
                "step": "install_aq",
                "exitStatus": r2.exit_status,
                "stdout": (r2.stdout or "")[-4000:],
                "stderr": (r2.stderr or "")[-4000:],
            }
        )

    probe_after = await _probe_remote(entry.conn)
    return {"ok": True, "remoteDir": remote_dir, "steps": steps, "probe": probe_after}


async def _forward_local(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    listen_host = str(params.get("listenHost") or "127.0.0.1")
    listen_port = int(params.get("listenPort") or 0)
    remote_host = str(params.get("remoteHost") or "127.0.0.1")
    remote_port = int(params.get("remotePort") or 0)
    if not remote_port:
        raise ValueError("remotePort is required")

    listener = await entry.conn.forward_local_port(listen_host, listen_port, remote_host, remote_port)
    fwd_id = str(uuid.uuid4())
    entry.forwards[fwd_id] = listener
    return {
        "forwardId": fwd_id,
        "listenHost": listen_host,
        "listenPort": listener.get_port(),
        "remoteHost": remote_host,
        "remotePort": remote_port,
    }


async def _forward_close(params: dict[str, Any]) -> dict[str, Any]:
    entry = _require_conn(params)
    fwd_id = str(params.get("forwardId") or "")
    listener = entry.forwards.pop(fwd_id, None)
    if listener is None:
        raise ValueError("unknown forwardId")
    listener.close()
    return {"ok": True}


async def main() -> None:
    # Read stdin in a thread — connect_read_pipe breaks when Electron/spawn
    # attaches a pipe that asyncio on some platforms rejects.
    loop = asyncio.get_event_loop()

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        raw = line.strip()
        if not raw:
            continue
        msg_id: str | None = None
        try:
            msg = json.loads(raw)
            msg_id = str(msg.get("id")) if msg.get("id") is not None else None
            method = str(msg.get("method") or "")
            params = msg.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
            result = await handle(method, params)
            reply(msg_id, result=result)
            if method == "shutdown":
                break
        except Exception as exc:
            tb = traceback.format_exc(limit=4)
            sys.stderr.write(tb + "\n")
            sys.stderr.flush()
            reply(msg_id, error=str(exc))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
