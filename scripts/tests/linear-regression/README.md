# Linear regression — end to end

This folder is a run (`recipe.yaml` + data; `artifacts/` on train). True line: `y = 2x + 3`. Fit on `data.csv`. Gate is MSE on `evals/holdout.csv` (`min_score` 0.01, lower is better). After train, `artifacts/inspect.md` should show intercept near 3 and `x` near 2.

Build the CLI first (from repo root):

```
cd aq && npm run build
cd ..
```

`aq` below means `aq/bin/aq` from the repo root (or that binary on your PATH).

Do not tick TODO until CLI, agent, and SDK paths work.

---

## 1. Manual CLI

From the repo root:

```
./aq/bin/aq doctor scripts/tests/linear-regression
./aq/bin/aq data hash scripts/tests/linear-regression
./aq/bin/aq train scripts/tests/linear-regression
./aq/bin/aq eval scripts/tests/linear-regression
./aq/bin/aq status scripts/tests/linear-regression
```

Or:

```
cd scripts/tests/linear-regression
../../../aq/bin/aq train
../../../aq/bin/aq eval
cat artifacts/inspect.md
../../../aq/bin/aq status
```

Expect:

- train writes `artifacts/checkpoints/last.json` and `artifacts/inspect.md`
- eval prints `mse`, a tiny score, `pass`
- inspect: `intercept` ≈ 3, `x` ≈ 2
- `aq eval` fail if you raise `eval.min_score` to something below the MSE (try `0` after a noisy edit) — only if you want to see fail

Also:

```
./aq/bin/aq diff scripts/tests/linear-regression
```

after two trains (run train twice) to compare run records.

---

## 2. Agent

From the run (TTY):

```
cd scripts/tests/linear-regression
../../../aq/bin/aq
```

Need a provider (`aq provider openai` or ollama). Then ask, in your own words:

1. Hash the data, then train this linear train.
2. Eval on the holdout. Report the real mse and pass/fail from `aq eval`. Do not invent a pass.
3. Read `artifacts/inspect.md` and say the intercept and the weight on `x`.

Or one-shot (no chat UI):

```
./aq/bin/aq ask scripts/tests/linear-regression -y --json "Train this linear model, then aq eval. Report mse and pass/fail from the eval file. Then read artifacts/inspect.md."
```

`-y` auto-approves `run`. Watch that it uses `aq train` / `aq eval` (or `aq_train` / `aq_eval`), not a made-up score.

---

---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/linear-regression")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI: train + eval pass, inspect looks like `y = 2x + 3`
- Agent: same, and it does not claim pass if eval failed
- SDK: train + eval pass on this folder
