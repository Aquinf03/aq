# aq-agent

Standalone Aquin **agent** (chat / ask / spawn / provider / doctor).  
The **framework** CLI (`aq train` / `eval` / `jobs` / …) lives in [`../aq`](../aq).

```
agent/                 ← this package (repo root)
aq/                    ← framework (kernel + train/eval/fleet)
```

## Install (monorepo)

```bash
cd aq && npm i && npm link          # framework bin: aq
cd ../agent && npm i && npm link    # agent bin: aq-agent
```

Agent finds the framework via sibling `../aq`, or `AQ_ROOT=/path/to/aq`, or `AQ_BIN=/path/to/aq/bin/aq`.

## Use

```bash
aq-agent                 # TTY chat (cwd should be a train with recipe.yaml)
aq-agent ask "summarize recipe.yaml"
aq-agent provider openai
aq-agent doctor
```

Framework verbs from chat still shell out to `aq` (`aq_train`, `aq_eval`, …).

## Layout

```
src/cli.ts       entry
src/agent/       chat UI, tools, spawn, provider
src/lib/         files / skills / memory / mcp (agent-owned)
src/job/         detached worker queue for spawn
src/core/        train schema + paths + locate aq framework
```
