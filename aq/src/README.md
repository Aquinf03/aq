# aq/src

TypeScript CLI. The current directory is the run (`recipe.yaml`).

```
cli.ts          entry. routes verbs.
help.ts
core/           schema, recipe-yaml, paths, kernel bridge, package roots
handle/         run verbs: init fork checkout status diff data step stage tool
job/            queue + plans (plans: in recipe.yaml; state under artifacts/)
agent/          chat, ask, spawn, doctor, provider
lib/            files, explore, memory, skills, mcp, web, registry
```

Kernel lives in `kernel/` inside this package. Templates in `templates/` (recipe.yaml + example.py). Assets in `assets/`.
