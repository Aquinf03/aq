#!/usr/bin/env bash
# Summarize aq download metrics from R2 (requires R2 read credentials).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$ROOT/node_modules/@aws-sdk/client-s3" ]; then
  echo "Installing script dependencies ..."
  (cd "$ROOT" && npm install --silent)
fi

exec node "$ROOT/download-metrics.mjs" "$@"
