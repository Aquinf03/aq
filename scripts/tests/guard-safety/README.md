# guard-safety

Opt-in `guard.safety`: one good train, one bad train that blows up **for several steps** and gets killed.

```
aq train scripts/tests/guard-safety/good
aq train scripts/tests/guard-safety/bad
```

**good** — should finish (~2s).

**bad** — should fail mid-run with `guard.safety: loss blew up for N consecutive steps…`.
---

## SDK (`aquin`)

Identity is **`recipe.yaml` + `artifacts/`** (created on train). `experiment.md` is optional.

`good` should settle; `bad` should abort mid-train.

```bash
aq/kernel/.venv/bin/pip install -e ./aq   # once per checkout
AQ_KERNEL=$PWD/aq/kernel aq/kernel/.venv/bin/python <<'PY'
from aquin import Aquin
aq = Aquin("scripts/tests/guard-safety/good")
print(aq.train())
print(aq.eval())
aq = Aquin("scripts/tests/guard-safety/bad")
print(aq.train())
print(aq.eval())
print(aq.status())
PY
```

CLI parity: `./aq/bin/aq train scripts/tests/<path>` then `eval` on the same path(s).



## Pass bar

- CLI and SDK: train + eval succeed per this README (or documented skip)
