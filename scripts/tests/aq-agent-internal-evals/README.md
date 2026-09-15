# aq-agent-internal-evals

Internal only. Our bar for the aq agent. Not a user feature. Not `evals/` in a train. Not `aq eval`. Not `aq init`.

Each case is a fixture train, a prompt, and a probe. The runner copies the fixture, runs `aq ask -y --json`, then the probe pass/fails on the tree and the tool trace.

```
node aq-agent-internal-evals/run.mjs
node aq-agent-internal-evals/run.mjs follow-skill
```

Needs a configured provider (`aq provider`). `AQ` overrides the aq binary. Work copies land in `.work/` (gitignored).

## Note (SDK-first)

Fixture trains under `fixtures/` / case overlays are still **`recipe.yaml` runs**. This suite exercises the agent CLI, not `aquin` directly. Identity does not require `experiment.md` or a slot forest.
