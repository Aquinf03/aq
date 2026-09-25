# sdk-table — `table()` rows + interactive `aq plot table`

Exact feel (from repo root):

```bash
# 1) rebuild CLI once (after pulling)
cd /Users/ashm/work/aqfw/aq && npm run build && cd ..

# 2) seed rows (SDK — one line per example)
cd /Users/ashm/work/aqfw/scripts/tests/sdk-table
PYTHONPATH=../../../aq:../../../aq/kernel ../../../aq/kernel/.venv/bin/python example.py

# 3) interactive browser (must be a real terminal — not piped)
cd /Users/ashm/work/aqfw
./aq/bin/aq plot scripts/tests/sdk-table table preds   # one table
./aq/bin/aq plot scripts/tests/sdk-table table all     # everything (_table column)
```

Or from inside the train folder:

```bash
cd /Users/ashm/work/aqfw/scripts/tests/sdk-table
../../../aq/bin/aq plot table preds
```

**Keys:** `↑` `↓` scroll · `←` `→` page · `/` or `Ctrl+F` find · `s` sort · `c` clear filter · `q` quit

```python
from aquin import table
table("preds", id=i, y=y, yhat=yhat, err=err, text=text)
```
