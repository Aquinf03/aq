# Point Electron at the Python venv when present (dev convenience).
# Usage from scripts/desktop/: source desktop/env.sh && npm run desktop:electron
export AQUIN_PYTHON="${AQUIN_PYTHON:-$(cd "$(dirname "$0")/ssh-service" && pwd)/.venv/bin/python}"
