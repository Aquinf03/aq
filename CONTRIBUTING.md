# Contributing to Aquin Framework

Thanks for taking the time to contribute. We welcome bug reports, docs fixes, tests, and pull requests.

## Who this is for

People who train and check models as **directory-shaped work** — researchers, applied ML engineers, and anyone who wants a train to be forkable, resumable, and auditable from disk. If you live in notebooks that never become a repo, or platforms that own your runs for you, this is probably not your primary tool.

## What problem it solves

ML work scatters across scripts, mystery checkpoints, and chat logs. **aq** makes the unit of work a folder: `recipe.yaml` (what to run) + `artifacts/` (what happened). The CLI (`aq`) and Python kernel share that contract. You grow the folder, run verbs against it, and leave enough on disk that someone else (or you next week) can resume without reconstructing context from memory.

## What makes this different

| | Direct / adjacent | aq |
|--|-------------------|-----|
| Notebooks / ad-hoc scripts | Fast start, weak provenance | Same speed for a train folder; disk is the source of truth |
| Trainer / Lightning / HF stacks | Strong libraries; you still invent the project shell | Thin adapters over those stacks; the shell is the product |
| MLflow / W&B / platforms | Tracking as a service | Tracking as files under `artifacts/` you can `git`-friend and fork |
| Agent-only tools | Chat owns the session | Agent is **axi** (separate); aq owns trains and verbs |

Indirect competition is “just write a script.” aq is for when you want that script to become a **reproducible train** without adopting a heavyweight platform.

## What success feels like

```bash
aq doctor    # exit 0
aq version   # prints 0.0.x
aq init demo && cd demo
# point recipe.yaml → a tiny dataset
aq train && aq eval   # exit 0; artifacts/ written
```

**Success = exit code 0** and a train folder you can reopen later. If doctor or train fails, fix that before opening a PR about higher-level behavior.

## Table of contents

- [Who this is for](#who-this-is-for)
- [What problem it solves](#what-problem-it-solves)
- [What makes this different](#what-makes-this-different)
- [What success feels like](#what-success-feels-like)
- [Quick start](#quick-start)
- [PR requirements](#pr-requirements)
- [Core areas (higher bar)](#core-areas-higher-bar)
- [AI tool usage](#ai-tool-usage)
- [Testing](#testing)
- [PR description template](#pr-description-template)
- [Code style](#code-style)
- [Types of contributions](#types-of-contributions)
- [Reporting bugs & proposing features](#reporting-bugs--proposing-features)
- [Security](#security)
- [Questions](#questions)

## Quick start

Needs **Node ≥ 18**, **npm**, and **Python >= 3.10**. You must **create the kernel Python env** — the CLI alone is not enough for train/eval.

```bash
# 1. Fork, then clone your fork
git clone https://github.com/YOUR_USERNAME/aq.git
cd aq

# 2. Install the CLI from the checkout
cd aq && npm install && npm link
cd ..

# 3. Create the Python env (required — do not skip)
python3 -m venv aq/kernel/.venv
aq/kernel/.venv/bin/pip install -U pip
aq/kernel/.venv/bin/pip install -r aq/kernel/requirements.txt
# optional SDK editable install:
# aq/kernel/.venv/bin/pip install -e ./aq

# or from the repo root (creates the venv for you):
# ./install.sh

# 4. Smoke-check — expect exit code 0
aq help
aq doctor
aq version
```

`aq` prefers `aq/kernel/.venv` when present. After TypeScript edits:

```bash
cd aq && npm run build
```

User docs: https://aquinf03.github.io/aq/documentation/ · [`docs/documentation/`](./docs/documentation/) · Changelog: [`docs/changelog/`](./docs/changelog/) · SDK: [`aq/SDK.md`](./aq/SDK.md).

## PR requirements

Before you open a pull request:

1. **Keep PRs focused:** one logical change per PR. Split large work.
2. **Describe the why:** use the [PR description template](#pr-description-template). Vague titles like "Fixed bug" will be sent back.
3. **Exercise the change:** for CLI/kernel behavior, run a relevant train under [`scripts/tests/`](./scripts/tests/) (see [Testing](#testing)). Say what you ran.
4. **Discuss big changes first:** open an issue for new methods, protocol changes, or anything that reshapes the train directory contract.
5. **Do not commit secrets or junk:** never add `.env`, API keys, tokens, or local artifacts that contain credentials. Also ignore (do not commit) heavy artifacts, caches, and anything unused or unnecessary for runtime or build-time (model weights, checkpoints, `node_modules/`, `.venv/`, build outputs, train `artifacts/` from local runs, and similar).

## Core areas (higher bar)

Changes that touch the train contract or the TS ↔ Python bridge are reviewed more strictly:

| Area | Paths |
|------|--------|
| CLI / verbs | `aq/src/cli.ts`, `aq/src/handle/`, `aq/src/core/` |
| Framework CLI | `aq/src/` (`aq` bin — train / eval / fleet) |
| Kernel entry / engine | `aq/kernel/run.py`, `aq/kernel/engine/` |
| Protocol (recipe, metrics, methods) | `aq/kernel/protocol/` |
| Training methods | `aq/kernel/methods/` |
| Install / release | `install.sh`, `scripts/helpers/release.sh` · account UI at aquin.app/aq |

For these areas, please:

- Link an issue that states the user-visible problem and expected behavior
- Include a **minimal reproduction** (often a tiny train under `scripts/tests/` or steps against an existing one)
- Explain root cause and why the fix is correct
- Note at least one failure mode you considered

PRs that change core behavior without a reproduction or rationale may be closed until that is provided.

## AI tool usage

AI-assisted contributions are welcome. You are accountable for every line you submit.

- Disclose AI use in the PR description if tools materially wrote or rewrote code
- Be able to explain the change without re-asking the model
- Do not submit unreviewed AI output, especially tests that only look plausible
- Undisclosed AI use or inability to defend the change may result in the PR being closed

## Testing

### CI (GitHub Actions)

Every push/PR runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):

| Gate | What |
|------|------|
| TypeScript | `npm ci` + `npm run build` |
| CLI packaging | `npm pack` includes `bin/aq` + `dist/cli.js`; `aq help` / `aq version` |
| Python | create venv, `pip install -e ./aq`, `import aquin`, `compileall` on `aquin` + `kernel` |
| Basic SDK | `scripts/tests/sdk-ridge` (`example.py` train/eval) with sklearn only |

**Exit code 0 on CI is required.** It is a smoke gate — not full method coverage.

### Manual end-to-end trains

Deeper coverage is still **manual trains** under [`scripts/tests/`](./scripts/tests/). CI does not replace those for new methods or GPU paths.

```bash
cd aq && npm run build   # if you changed TypeScript
# create kernel venv if needed (see Quick start)
cd ../scripts/tests/linear-regression   # or another relevant train
aq train
aq eval
aq status
# read artifacts/inspect.md
```

Pick the train that proves what you changed. Index: [`scripts/tests/README.md`](./scripts/tests/README.md).

| Change type | Expectation |
|-------------|-------------|
| Bug fix | Reproduce with a train (or add/adjust one), then show it passes; CI green |
| New method / recipe knob | Add or extend a `scripts/tests/` train that exercises it |
| Docs only | No train run required; CI still runs |
| Refactor | Existing relevant trains still work; say which ones you ran; CI green |

GPU-only paths (e.g. QLoRA) may need CUDA; note that in the PR if you could not run them locally.

## PR description template

```markdown
## Summary
Brief (1-2 sentences) description of what this PR does.

## Context / Motivation
Why is this needed? Link issues: Fixes #123

## Changes
- Specific code / behavior changes
- Breaking changes or deprecations, if any

## Testing
- Trains run: e.g. `scripts/tests/linear-regression` (`aq train` / `aq eval`)
- Commands / edge cases checked
- AI assistance used? (yes/no; short note if yes)
```

## Code style

- Match the surrounding code; prefer small, readable changes over new abstractions
- TypeScript: existing patterns in `aq/src`; build must succeed (`npm run build` in `aq/`)
- Python: follow nearby kernel style in `aq/kernel`
- Do not commit `node_modules/`, `aq/kernel/.venv/`, `.env*`, build caches, or large model weights
- Keep the train directory contract clear: recipe + data + artifacts on disk remain the source of truth

## Types of contributions

**Code:** bug fixes, features, performance, refactors  
**Docs:** static HTML under `docs/documentation/` + `docs/changelog/` (GitHub Pages), SDK README, clarifications  
**Tests:** new or tighter trains under `scripts/tests/`  
**Issues:** clear bug reports and focused feature proposals  

All of these help. Docs and reproduction cases are as valuable as features.

## Reporting bugs & proposing features

**Bugs:** open a GitHub issue with:

- Clear title
- Steps to reproduce
- Expected vs actual behavior
- Environment: OS, `node -v`, `python3 --version` (need >= 3.10), `aq version`
- Logs / stack traces and a minimal train or command sequence when possible

**Features:** open an issue first for anything beyond a small fix. Describe the problem, proposed approach, and alternatives. Wait for feedback before a large PR.

## Security

Public issues for vulnerabilities will be **closed immediately**. You must email **aquin@aquin.app**. See [`SECURITY.md`](./SECURITY.md).

## Questions

- Usage / how-to: https://aquinf03.github.io/aq/documentation/ · [`docs/documentation/`](./docs/documentation/)
- SDK: [`aq/SDK.md`](./aq/SDK.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- Contact: aquin@aquin.app

Thank you for contributing.
