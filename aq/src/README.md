# aq/src

TypeScript **framework** CLI. The current directory is the run (`recipe.yaml`).

```
cli.ts          entry. routes verbs.
help.ts
core/           schema, recipe-yaml, paths, kernel bridge, package roots
handle/         run verbs: init status diff data step track plot login update
fleet/          SSH places/pools: add / places / launch / go / jobs
lib/            plot-config, term-table
```

Agent chat / ask / spawn / provider / doctor live in the separate **`axi`** package, not here.

Kernel lives in `kernel/` inside this package. Templates in `templates/`. Assets that remain framework-specific stay under `assets/` if any.
