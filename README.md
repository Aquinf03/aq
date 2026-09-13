# Aquin Framework

**aq** is the CLI. The Python kernel ships inside the `aq` package.  
**SDK shape:** `aquin` client + `recipe.yaml` + `artifacts/` folder.

**Docs:** https://aq.aquin.app/docs · **Account / install:** https://aq.aquin.app  
**SDK:** [`sdk/`](./sdk/README.md) · **Trains:** [`tests/`](./tests/README.md)

## Published build install

```bash
curl -fsSL https://aq.aquin.app/framework/install.sh | bash
```

Needs **Node ≥ 18**, **npm**, and **Python >= 3.10**. Then `aq help` · `aq doctor`.

## SDK (few lines)

```bash
aq/kernel/.venv/bin/pip install -e ./sdk
python -m aquin init my-run   # or: aq init my-run
cd my-run && python example.py
```

See [`tests/sdk-ridge/example.py`](./tests/sdk-ridge/example.py) and [`tests/sdk-from-dict/example.py`](./tests/sdk-from-dict/example.py).

## From a checkout (CLI)

```bash
cd aq && npm install && npm link
# or
./install.sh
```

## Use (CLI)

```bash
aq init my-train && cd my-train
# edit recipe.yaml + data
aq train && aq eval && aq status
```

## Layout

| Path | Role |
|------|------|
| `aq/` | CLI + Python kernel |
| `sdk/` | Python `aquin` SDK |
| `tests/` | E2E trains (CLI + SDK) |
| `web/` | Docs + auth app (`aq.aquin.app`) |
| `internals/` | Builder checklists + author notes |

- Publish: [`scripts/release.sh`](./scripts/release.sh) · [internals/author/release.md](./internals/author/release.md)
- SDK design: [`internals/author/sdk-first.md`](./internals/author/sdk-first.md)
