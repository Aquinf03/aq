# Aquin Framework

**aq** is the CLI. The Python kernel ships inside the `aq` package.  
**SDK shape:** `recipe.yaml` (path map) + `artifacts/` (runtime). Author with **YAML and/or `aquin`** — both first-class.

**Docs:** https://aquinf03.github.io/aq/documentation/ · **Changelog:** https://aquinf03.github.io/aq/changelog/ · **Account / install:** https://aq.aquin.app  
**SDK:** [`aq/aquin`](./aq/SDK.md) · **Trains:** [`scripts/tests/`](./scripts/tests/README.md)

## Published build install

```bash
curl -fsSL https://aq.aquin.app/framework/install.sh | bash
```

Needs **Node ≥ 18**, **npm**, and **Python >= 3.10**. Then `aq help` · `aq doctor`.

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
| `docs/` | GitHub Pages: `documentation/` + `changelog/` (markdown notes + HTML) + `assets/` |
| `web/` | Auth / account app (`aq.aquin.app`) |
| `internals/` | Builder checklists |

- Publish: [`scripts/helpers/release.sh`](./scripts/helpers/release.sh)
- SDK: [`aq/SDK.md`](./aq/SDK.md)
