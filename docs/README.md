# Static aq docs (GitHub Pages)

HTML under `docs/` is the public product docs (same stone chrome as the old web docs).

The previous TypeScript source (`web/lib/docs`) was cleared; **edit these HTML files directly** for now. Prefer keeping pages consistent with SDK-first: `recipe.yaml` + `example.py` + `artifacts/`.

SSH fleet (places / jobs / pools) lives at [`fleet/`](fleet/). Keep that page and the fleet sections in [`cli/`](cli/) and [`jobs/`](jobs/) aligned with `aq help` + `aq/SDK.md`.

Point GitHub Pages at the `/docs` folder on your default branch.
