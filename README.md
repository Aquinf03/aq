# Aquin Framework

[![CI](https://github.com/aquinf03/aq/actions/workflows/ci.yml/badge.svg)](https://github.com/aquinf03/aq/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

**aq** is the CLI. The Python kernel ships inside the `aq` package.  
**SDK shape:** `recipe.yaml` (path map) + `artifacts/` (runtime). Author with **YAML and/or `aquin`** — both first-class.  
Chat (`axi`) is a **separate package** — not this repo’s product surface.

**Repo:** https://github.com/aquinf03/aq · **Docs:** https://aquinf03.github.io/aq/documentation/ · **Changelog:** https://aquinf03.github.io/aq/changelog/  
**SDK:** [`aq/SDK.md`](./aq/SDK.md) · **Trains:** [`scripts/tests/`](./scripts/tests/README.md) · **Shipped:** [`COMPLETED.md`](./COMPLETED.md)

**Contributing** · [`CONTRIBUTING.md`](./CONTRIBUTING.md) · **Code of conduct** · [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · **Security** · [`SECURITY.md`](./SECURITY.md) · **License** · [`LICENSE`](./LICENSE)

Good first contributions: docs clarifications under `docs/documentation/`, tighter trains under `scripts/tests/`, and small CLI / SDK fixes with a reproduction.

## Published build install

```bash
curl -fsSL https://github.com/Aquinf03/aq/releases/latest/download/install.sh | bash
```

Needs **Node ≥ 18**, **npm**, and **Python >= 3.10**. Then `aq help`.

Or from source: clone https://github.com/aquinf03/aq and see [From a checkout](#from-a-checkout-cli).

## SDK (few lines)

```bash
aq/kernel/.venv/bin/pip install -e ./aq
python -m aquin init my-run   # or: aq init my-run
cd my-run && python example.py
```

See [`scripts/tests/sdk-ridge/example.py`](./scripts/tests/sdk-ridge/example.py), [`scripts/tests/sdk-from-dict/example.py`](./scripts/tests/sdk-from-dict/example.py), [`scripts/tests/sdk-run-class/example.py`](./scripts/tests/sdk-run-class/example.py).

## From a checkout (CLI)

```bash
cd aq && npm install && npm link
# or
./install.sh
```

## Use (CLI)

```bash
aq init my-train && cd my-train
# edit recipe.yaml → data.path
aq train && aq eval && aq status
```

## Layout

| Path | Role |
|------|------|
| `aq/` | CLI + Python kernel + `aquin` SDK (`aq/aquin`, `pip install -e ./aq`) |
| `scripts/tests/` | E2E trains (CLI + SDK) |
| `scripts/desktop/` | Electron workspace (Vite UI + AsyncSSH) |
| `docs/` | GitHub Pages: `documentation/` + `changelog/` (markdown notes + HTML) + `assets/` |
| `COMPLETED.md` | What ships (public inventory) |
| `internals/` | Builder checklists (framework only) |

- Publish: [`scripts/helpers/release.sh`](./scripts/helpers/release.sh)
- SDK: [`aq/SDK.md`](./aq/SDK.md)
