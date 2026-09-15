# Contributing to Aquin Framework

Thanks for taking the time to contribute. We welcome bug reports, docs fixes, tests, and pull requests.

## Table of contents

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

```bash
# 1. Fork, then clone your fork
git clone https://github.com/YOUR_USERNAME/aqfw.git
cd aqfw

# 2. Install the CLI from the checkout
cd aq && npm install && npm link
# or from the repo root:
# ./install.sh

# 3. Smoke-check
aq help
aq doctor
aq version
```

Needs **Node ≥ 18**, **npm**, and **Python >= 3.10**. After TypeScript edits:

```bash
cd aq && npm run build
```

User docs: https://aquinf03.github.io/aq · [`docs/`](./docs/) · SDK: [`aq/SDK.md`](./aq/SDK.md).

## PR requirements

Before you open a pull request:

1. **Keep PRs focused:** one logical change per PR. Split large work.
2. **Describe the why:** use the [PR description template](#pr-description-template). Vague titles like "Fixed bug" will be sent back.
3. **Exercise the change:** for CLI/kernel behavior, run a relevant train under [`tests/`](./tests/) (see [Testing](#testing)). Say what you ran.
4. **Discuss big changes first:** open an issue for new methods, protocol changes, or anything that reshapes the train directory contract.
5. **Do not commit secrets or junk:** never add `.env`, API keys, tokens, or local artifacts that contain credentials. Also ignore (do not commit) heavy artifacts, caches, and anything unused or unnecessary for runtime or build-time (model weights, checkpoints, `node_modules/`, `.venv/`, build outputs, train `artifacts/` from local runs, and similar).

## Core areas (higher bar)

Changes that touch the train contract or the TS ↔ Python bridge are reviewed more strictly:

| Area | Paths |
|------|--------|
| CLI / verbs | `aq/src/cli.ts`, `aq/src/handle/`, `aq/src/core/` |
| Agent | `aq/src/agent/` |
| Kernel entry / engine | `aq/kernel/run.py`, `aq/kernel/engine/` |
| Protocol (recipe, metrics, methods) | `aq/kernel/protocol/` |
| Training methods | `aq/kernel/methods/` |
| Install / release | `install.sh`, `scripts/release.sh`, `web/public/framework/` |

For these areas, please:

- Link an issue that states the user-visible problem and expected behavior
- Include a **minimal reproduction** (often a tiny train under `tests/` or steps against an existing one)
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

This repo does **not** use a single unit-test suite as the primary gate. Coverage lives as **manual end-to-end trains** in [`tests/`](./tests/).

Each folder is a train (plus a README). Typical loop:

```bash
cd aq && npm run build   # if you changed TypeScript
cd ../tests/linear-regression   # or another relevant train
aq train
aq eval
aq status
# read artifacts/inspect.md
```

Pick the train that proves what you changed. Index: [`tests/README.md`](./tests/README.md).

| Change type | Expectation |
|-------------|-------------|
| Bug fix | Reproduce with a train (or add/adjust one), then show it passes |
| New method / recipe knob | Add or extend a `tests/` train that exercises it |
| Docs only | No train run required |
| Refactor | Existing relevant trains still work; say which ones you ran |

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
- Trains run: e.g. `tests/linear-regression` (`aq train` / `aq eval`)
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
**Docs:** static HTML under `docs/` (GitHub Pages), SDK README, clarifications  
**Tests:** new or tighter trains under `tests/`  
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

- Usage / how-to: https://aquinf03.github.io/aq · [`docs/`](./docs/)
- SDK: [`aq/SDK.md`](./aq/SDK.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- Contact: aquin@aquin.app

Thank you for contributing.
