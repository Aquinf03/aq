# Heuristics

- Eval is thin: only 5 eval rows (low trust). Do not treat deltas under 0.02 as real.

- The eval is too thin to trust: with only 5 eval rows, label results low-confidence and do not treat deltas under 0.02 as meaningful.
