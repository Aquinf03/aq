# Static aq docs (GitHub Pages)

Public product docs. Point GitHub Pages at the `/docs` folder on the default branch.

```
docs/
  documentation/   # product docs (getting started, CLI, fleet, methods, …)
  changelog/       # release notes (markdown + Pages HTML)
  assets/          # shared chrome (CSS, logo, favicon)
  index.html       # redirects → documentation/
```

**Edit under `documentation/` and `changelog/` directly.** Prefer SDK-first copy: `recipe.yaml` + `example.py` + `artifacts/`.

- Docs home: [`documentation/`](documentation/)
- SSH fleet: [`documentation/fleet/`](documentation/fleet/) — keep aligned with `aq help` + `aq/SDK.md` (also CLI / jobs pages)
- Changelog: [`changelog/`](changelog/) — markdown notes (`v0.0.5.md`, `versions/`) plus `index.html` for Pages. Indexed from root [`CHANGELOG.md`](../CHANGELOG.md).

Root URL `https://aquinf03.github.io/aq/` redirects into `documentation/`. Changelog: `…/aq/changelog/`.
