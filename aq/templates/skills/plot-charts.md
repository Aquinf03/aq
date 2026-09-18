# Plot charts from train artifacts

When the user asks for a graph, chart, plot, sample grid, or diagram:

1. Use the **plot** tool (or `aq plot`).
2. `kind: metrics` — loss/lr curve from `artifacts/metrics.jsonl` (matplotlib)
3. `kind: jobs` — job status bar chart from `jobs/` (matplotlib)
4. `kind: runs` — compare experiment scores from `artifacts/runs/` (matplotlib)
5. `kind: samples` (alias `vision`) — image montage from `artifacts/samples/`, `artifacts/previews/`, or recipe image folders (torchvision `make_grid` if installed, else Pillow)
6. `kind: all` — scalar charts + samples when images exist

Output lands in `artifacts/plots/` (PNG by default). Tell the user the file path.

Optional `recipe.yaml`:

```yaml
plot:
  auto: true
  format: png
  dpi: 150
  charts: [metrics, jobs, runs, samples]
```

Global defaults also live in `~/.aq/config.json` under `plot`.

For vision trains, drop preview images into `artifacts/samples/` (or class folders under `data/`) then `aq plot samples`.
