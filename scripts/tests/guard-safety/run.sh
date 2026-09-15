#!/usr/bin/env bash
# Uses `aq` on PATH (same as you).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/tests/guard-safety"

if ! command -v aq >/dev/null 2>&1; then
  echo "aq not on PATH"
  exit 1
fi

mkdir -p "$HERE/good/tools" "$HERE/bad/tools"
# Prefer shared methods/ if present; else each fixture already has tools/watchdemo.py
if [[ -f "$HERE/methods/watchdemo.py" ]]; then
  cp -f "$HERE/methods/watchdemo.py" "$HERE/good/tools/watchdemo.py"
  cp -f "$HERE/methods/watchdemo.py" "$HERE/bad/tools/watchdemo.py"
fi

rm -f "$HERE/good/artifacts/metrics.jsonl" "$HERE/bad/artifacts/metrics.jsonl"

echo "== aq train scripts/tests/guard-safety/good =="
aq train "$HERE/good"
grep -q '"event": "step"' "$HERE/good/artifacts/metrics.jsonl"
! grep -q '"event": "guard.abort"' "$HERE/good/artifacts/metrics.jsonl"
echo "good: ok"

echo
echo "== aq train scripts/tests/guard-safety/bad (expect fail) =="
set +e
aq train "$HERE/bad"
CODE=$?
set -e
if [[ "$CODE" -eq 0 ]]; then
  echo "FAIL: bad train should exit non-zero"
  exit 1
fi
grep -q '"event": "guard.abort"' "$HERE/bad/artifacts/metrics.jsonl"
echo "bad: ok (aborted)"

echo
echo "guard-safety: pass"
