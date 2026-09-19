#!/usr/bin/env bash
# Install aq (CLI + bundled kernel). Use bash: curl … | bash
# Never needs sudo — links into ~/.local (not /usr/local).
# Works on macOS, Linux, and Windows (Git Bash / MSYS2). Never uses mkdir -p via cmd.exe.
set -euo pipefail

INSTALL_DIR="${AQUIN_INSTALL_DIR:-$HOME/.local/share/aquin-framework}"
BRANCH="${AQUIN_BRANCH:-main}"
DEFAULT_RELEASE_URL="https://aq.aquin.app/releases/aq-latestv.tar.gz"
# User-writable npm global prefix (avoids EACCES on /usr/local/lib/node_modules)
NPM_PREFIX="${AQUIN_NPM_PREFIX:-$HOME/.local}"

is_windows() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) return 0 ;;
  esac
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  return 1
}

# Portable mkdir -p (bash/mkdir both fine; never invoke cmd's mkdir).
mkd() {
  # shellcheck disable=SC2086
  command mkdir -p -- "$@" 2>/dev/null || command mkdir -p "$@"
}

# Prefer python3, then Windows `py -3`, then python.
find_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v py >/dev/null 2>&1; then
    if py -3 -c "import sys" >/dev/null 2>&1; then
      echo "py -3"
      return 0
    fi
  fi
  if command -v python >/dev/null 2>&1; then
    # reject Windows Store stub that prints an alias tip and exits
    if python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then
      command -v python
      return 0
    fi
  fi
  return 1
}

# BASH_SOURCE is unset when the script is piped: curl … | bash
script_dir() {
  local src="${BASH_SOURCE[0]:-}"
  case "$src" in
    "" | bash | /bin/bash | /usr/bin/bash | sh | /bin/sh) return 0 ;;
  esac
  if [ ! -f "$src" ]; then
    return 0
  fi
  cd "$(dirname "$src")" && pwd
}

SCRIPT_DIR="$(script_dir || true)"

command -v node >/dev/null || { echo "Node.js required (>=18)"; exit 1; }
command -v npm >/dev/null || { echo "npm required"; exit 1; }
PYTHON_BIN="$(find_python)" || {
  echo "Python 3 required (python3 on PATH, or Windows: py -3 / python)." >&2
  exit 1
}

ensure_path_hint() {
  local bin="$NPM_PREFIX/bin"
  mkd "$bin"
  # Bash may have cached a deleted path from a prior install.
  hash -r 2>/dev/null || true
  if ! echo ":$PATH:" | grep -q ":$bin:"; then
    echo ""
    if is_windows; then
      echo "Add this to your PATH (User env vars, or Git Bash ~/.bashrc):"
      echo "  export PATH=\"$bin:\$PATH\""
    else
      echo "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
      echo "  export PATH=\"$bin:\$PATH\""
      echo "Then: hash -r && source ~/.bashrc"
    fi
  fi
}

# Always leave a real executable at $NPM_PREFIX/bin/aq (never a dangling symlink).
link_aq() {
  local root="$1"
  local bin_dir="$NPM_PREFIX/bin"
  local pkg="$root/aq"
  local cli="$pkg/dist/cli.js"
  local launcher="$bin_dir/aq"
  local node_bin

  mkd "$bin_dir" "$NPM_PREFIX/lib/node_modules"
  node_bin="$(command -v node)"
  if [ ! -f "$cli" ]; then
    echo "build missing: $cli (npm install / prepare should have created it)" >&2
    exit 1
  fi

  # Best-effort: register the package under the user npm prefix (deps / doctor).
  npm install -g --prefix "$NPM_PREFIX" "$pkg" >/dev/null 2>&1 || true

  # Stable launcher — survives npm link quirks and broken global bins.
  # Absolute paths so it works even if cwd / PATH change.
  if is_windows; then
    # Bash + PowerShell/cmd launchers (no cmd.exe mkdir -p anywhere in the pipeline).
    cat >"$launcher" <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$cli" "\$@"
EOF
    chmod +x "$launcher" 2>/dev/null || true
    local cli_win node_win
    cli_win="$(cygpath -w "$cli" 2>/dev/null || echo "$cli")"
    node_win="$(cygpath -w "$node_bin" 2>/dev/null || echo "$node_bin")"
    # Escape backslashes for cmd — cygpath -w already uses backslashes.
    cat >"${launcher}.cmd" <<EOF
@echo off
"$node_win" "$cli_win" %*
EOF
  else
    cat >"$launcher" <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$cli" "\$@"
EOF
    chmod +x "$launcher"
  fi

  if [ ! -f "$launcher" ] && [ ! -f "${launcher}.cmd" ]; then
    echo "failed to write $launcher" >&2
    exit 1
  fi
  # Smoke-check with the full path (avoids bash hash of a missing file).
  if is_windows; then
    if ! node "$cli" version >/dev/null 2>&1 && ! node "$cli" help >/dev/null 2>&1; then
      echo "installed launcher but aq failed to run via node $cli" >&2
      exit 1
    fi
  else
    if ! "$launcher" version >/dev/null 2>&1 && ! "$launcher" help >/dev/null 2>&1; then
      echo "installed $launcher but it failed to run" >&2
      exit 1
    fi
  fi
  echo "linked  $launcher"
  if [ -f "${launcher}.cmd" ]; then
    echo "linked  ${launcher}.cmd"
  fi
}

install_kernel_venv() {
  local root="$1"
  local req="$root/aq/kernel/requirements.txt"
  local venv="$root/aq/kernel/.venv"
  [ -f "$req" ] || return 0

  echo "Installing kernel Python deps (venv)…"
  # Stale/partial venv (e.g. missing bin/python3) breaks pip shebangs — always recreate.
  rm -rf "$venv"
  # PYTHON_BIN may be "py -3" — word-split intentionally.
  # shellcheck disable=SC2086
  if ! $PYTHON_BIN -m venv "$venv"; then
    echo "Failed to create venv with: $PYTHON_BIN -m venv" >&2
    echo "On Debian/Ubuntu: sudo apt-get install -y python3-venv python3-pip" >&2
    echo "On Windows: install Python 3 from python.org (enable py launcher) or Microsoft Store." >&2
    exit 1
  fi
  local py=""
  if [ -x "$venv/bin/python" ]; then
    py="$venv/bin/python"
  elif [ -x "$venv/bin/python3" ]; then
    py="$venv/bin/python3"
  elif [ -f "$venv/Scripts/python.exe" ]; then
    py="$venv/Scripts/python.exe"
  elif [ -f "$venv/Scripts/python" ]; then
    py="$venv/Scripts/python"
  else
    echo "venv has no python binary under $venv/bin or $venv/Scripts" >&2
    exit 1
  fi
  # Use python -m pip (not bin/pip) so a missing python3 symlink cannot break the shebang.
  "$py" -m pip install -U pip
  "$py" -m pip install -r "$req"
}

install_from_dir() {
  local root="$1"
  if [ ! -f "$root/aq/package.json" ] || [ ! -f "$root/aq/kernel/run.py" ]; then
    echo "Not a framework tree (need aq/package.json and aq/kernel/run.py): $root" >&2
    exit 1
  fi
  cd "$root/aq"
  npm install
  link_aq "$root"
  install_kernel_venv "$root"
  echo "Installed under $root (npm prefix: $NPM_PREFIX)"
  echo "Run: aq help"
  echo "LLM/LoRA needs recipe.model (hub id). QLoRA needs CUDA + bitsandbytes."
  ensure_path_hint
  export PATH="$NPM_PREFIX/bin:$PATH"
  hash -r 2>/dev/null || true
  if [ -x "$NPM_PREFIX/bin/aq" ] || [ -f "$NPM_PREFIX/bin/aq" ] || [ -f "$NPM_PREFIX/bin/aq.cmd" ]; then
    if node "$root/aq/dist/cli.js" version >/dev/null 2>&1 || node "$root/aq/dist/cli.js" help >/dev/null 2>&1; then
      echo "OK: $NPM_PREFIX/bin/aq"
    fi
  else
    echo "WARNING: $NPM_PREFIX/bin/aq missing after install" >&2
  fi
  if command -v aq >/dev/null 2>&1; then
    :
  else
    echo "This shell cannot see 'aq' yet. Run: export PATH=\"$NPM_PREFIX/bin:\$PATH\" && hash -r"
  fi
  if [ -e /usr/local/lib/node_modules/aq ] || [ -L /usr/local/bin/aq ]; then
    echo ""
    echo "Note: an old global install may still shadow PATH."
    echo "  sudo npm unlink -g aq 2>/dev/null || sudo rm -f /usr/local/bin/aq"
    echo "  sudo rm -rf /usr/local/lib/node_modules/aq"
  fi
}

extract_release() {
  local archive="$1"
  local dest="$2"
  # Ignore macOS libarchive xattr noise when unpacking on Linux.
  if tar --help 2>&1 | grep -q -- '--warning='; then
    tar xzf "$archive" -C "$dest" --warning=no-unknown-keyword
  else
    tar xzf "$archive" -C "$dest" 2>/dev/null || tar xzf "$archive" -C "$dest"
  fi
}

install_from_release() {
  local url="$1"
  command -v curl >/dev/null || { echo "curl required." >&2; exit 1; }
  command -v tar >/dev/null || { echo "tar required." >&2; exit 1; }

  mkd "$INSTALL_DIR"
  local archive="$INSTALL_DIR/.release.tar.gz"
  echo "Installing Aquin..."
  if ! curl -fsSL "$url" -o "$archive" 2>/dev/null; then
    echo "Install unavailable. Try again later." >&2
    exit 1
  fi
  # Release tar only adds/overwrites — remove old aq/ so deleted sources (e.g. schedule.ts) don't linger.
  rm -rf "$INSTALL_DIR/aq"
  extract_release "$archive" "$INSTALL_DIR"
  rm -f "$archive"

  install_from_dir "$INSTALL_DIR"
}

# 1) Run from your checkout: ./install.sh
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/aq/package.json" ] && [ -f "$SCRIPT_DIR/aq/kernel/run.py" ]; then
  install_from_dir "$SCRIPT_DIR"
  exit 0
fi

# 2) Explicit local path: AQUIN_SOURCE=/path/to/aqfw ./install.sh
if [ -n "${AQUIN_SOURCE:-}" ]; then
  install_from_dir "$AQUIN_SOURCE"
  exit 0
fi

# 3) Private git remote: AQUIN_REPO=git@github.com:you/aqfw.git ./install.sh
if [ -n "${AQUIN_REPO:-}" ]; then
  command -v git >/dev/null || { echo "git required when using AQUIN_REPO"; exit 1; }

  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" || true
  else
    git clone --depth 1 --branch "$BRANCH" "$AQUIN_REPO" "$INSTALL_DIR"
  fi

  install_from_dir "$INSTALL_DIR"
  exit 0
fi

# 4) R2 release via aq.aquin.app (default for curl | bash)
if [ "${AQUIN_NO_RELEASE:-}" != "1" ]; then
  install_from_release "${AQUIN_RELEASE_URL:-$DEFAULT_RELEASE_URL}"
  exit 0
fi

echo "Install options:" >&2
echo "  ./install.sh              (from a checkout that contains aq/)" >&2
echo "  AQUIN_SOURCE=/path/to/aqfw ./install.sh" >&2
echo "  AQUIN_REPO=<git-url> ./install.sh" >&2
echo "  curl -fsSL https://aq.aquin.app/framework/install.sh | bash" >&2
exit 1
