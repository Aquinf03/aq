# aq/src

TypeScript CLI. The current directory is the run (`recipe.yaml`).

```
cli.ts          entry. routes verbs.
help.ts
core/           schema, recipe-yaml, paths, kernel bridge, package roots
handle/         run verbs: init fork (internal) status diff data step
fleet/          SSH places: add / places / launch / go / jobs (multi-cloud later)
job/            internal queue for spawn / agent detach (not a public CLI)
agent/          chat, ask, spawn, doctor, provider
lib/            files, explore, memory, skills, mcp, web, registry
```

Kernel lives in `kernel/` inside this package. Templates in `templates/` (recipe.yaml + example.py). Assets in `assets/`.
