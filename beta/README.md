# Aquin beta — desktop app

Electron control plane for the AQ workspace. UI is **Vite + React** (same components). Local `/api` and `/auth` still run via Next route handlers (proxied) so account/keys behavior is unchanged. Remote compute is **your** VM over **AsyncSSH** — AQ does not host GPUs.

## Setup

```bash
cd beta
npm install

cd desktop/ssh-service
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ../..
```

## Run

```bash
npm start
# or: npm run dev / npm run desktop
```

Electron starts:

1. Python AsyncSSH sidecar  
2. Next API on `localhost:3001` (internal)  
3. Vite UI on `localhost:3000` (proxies `/api` + `/auth` → 3001)  
4. The desktop window  

### macOS icon

Dock / window icon: `desktop/resources/icon.icns` (+ `AppIcon.appiconset` source).

### SSH Open folder

Sidebar → **SSH Open folder** → connect → browse → open.

## Layout

| Path | Role |
|------|------|
| `src/`, `components/`, `app/globals.css` | Vite UI |
| `app/api/`, `app/auth/callback` | API (Next process) |
| `desktop/electron/` | Electron main, preload, SSH bridge |
| `desktop/ssh-service/` | Python AsyncSSH JSON-RPC |
| `desktop/resources/` | macOS app icons |

## Env (optional)

- `AQUIN_UI_PORT` — Vite UI port (default `3000`)
- `AQUIN_API_PORT` — Next API port (default `3001`)
- `AQUIN_DESKTOP_URL` — skip spawning servers; load this URL instead
- `AQUIN_PYTHON` — Python binary (defaults to ssh-service venv)

## SSH RPC

`ping`, `shutdown`, `ssh.connect`, `ssh.disconnect`, `ssh.listdir`, `ssh.exec`, `ssh.read_file`, `ssh.write_file`, `ssh.bootstrap`, `ssh.forward_local`, `ssh.forward_close` — see `desktop/ssh-service/main.py`.
