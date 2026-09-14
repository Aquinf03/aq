# Aquin beta — desktop app

Electron control plane for the AQ workspace. The UI is still React/Next (rendered inside Electron only). Remote compute is **your** VM/machine over **AsyncSSH** — AQ does not host GPUs.

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
2. Next.js UI on `localhost:3000` (internal — not a public web product)  
3. The desktop window  

### SSH Open folder

Sidebar → **SSH Open folder** → connect (key / agent / password) → browse → open. First connect can bootstrap `~/.aquin` on the remote (optional `install.sh`).

## Layout

| Path | Role |
|------|------|
| `app/`, `components/` | UI (Next), only loaded in Electron |
| `desktop/electron/` | Electron main, preload, SSH bridge |
| `desktop/ssh-service/` | Python AsyncSSH JSON-RPC |
| `lib/desktop.ts` | `window.aquinDesktop` helpers |

## Env (optional)

- `AQUIN_UI_PORT` — UI port (default `3000`)
- `AQUIN_DESKTOP_URL` — skip spawning Next; load this URL instead
- `AQUIN_PYTHON` — Python binary (defaults to `desktop/ssh-service/.venv/bin/python` when present)

## SSH RPC

`ping`, `shutdown`, `ssh.connect`, `ssh.disconnect`, `ssh.listdir`, `ssh.exec`, `ssh.read_file`, `ssh.write_file`, `ssh.bootstrap`, `ssh.forward_local`, `ssh.forward_close` — see `desktop/ssh-service/main.py`.
