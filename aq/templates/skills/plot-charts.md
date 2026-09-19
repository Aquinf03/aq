# Plot charts from train artifacts

When the user asks for a graph, chart, plot, sample grid, or diagram:

1. Use the **plot** tool or `aq plot` with the options they want.
2. Kinds: `metrics` | `jobs` | `runs` | `samples` | `all`
3. Control the diagram — don’t assume defaults:

```bash
aq plot metrics --fields loss,lr --style line --title "loss" --figsize 7,4
aq plot samples --max 32 --nrow 4 --from artifacts/samples --backend auto
aq plot --charts metrics,samples --dpi 200
```

YAML (`recipe.yaml`):

```yaml
plot:
  auto: true
  format: png
  dpi: 150
  charts: [metrics, samples]
  metrics:
    fields: [loss, lr]
    x: step
    style: line
    show_lr: true
    figsize: [7, 4]
    metric_charts: [loss, eval]   # loss | eval | duration
  samples:
    max: 64
    thumb: 128
    nrow: 8
    dirs: [artifacts/samples]
    backend: auto                 # auto | torchvision | pillow | matplotlib
```

SDK:

```python
from aquin import Aquin
aq = Aquin(".")
aq.plot("metrics", fields=["loss"], title="loss")
aq.plot("samples", max=32, nrow=4)
aq.plot(charts=["metrics", "samples"], dpi=200)
```

Output: `artifacts/plots/`. Tell the user the path.
