#!/usr/bin/env bash
# Build a framework tarball and upload to Cloudflare R2 (releases bucket).
# Requires: wrangler logged in, bucket created (see scripts/helpers/cloudflare/releases-worker/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-latest}"
BUCKET="${AQUIN_R2_BUCKET:-releases}"

release_object_name() {
  echo "aq-${1}v.tar.gz"
}

command -v wrangler >/dev/null || {
  echo "wrangler CLI required: npm i -g wrangler && wrangler login" >&2
  exit 1
}

TMP="$(mktemp -d)"
ARCHIVE="$TMP/$(release_object_name "$VERSION")"
trap 'rm -rf "$TMP"' EXIT

echo "Building aq (TypeScript) ..."
(cd "$ROOT/aq" && npm run build)

echo "Packing tarball ..."
tar czf "$ARCHIVE" -C "$ROOT" \
  --exclude='aq/node_modules' \
  --exclude='aq/kernel/.venv' \
  --exclude='aq/**/__pycache__' \
  --exclude='aq/artifacts' \
  --exclude='.git' \
  aq install.sh README.md

REMOTE="$(release_object_name "$VERSION")"
echo "Uploading r2://${BUCKET}/${REMOTE} (remote) ..."
wrangler r2 object put "${BUCKET}/${REMOTE}" --file="$ARCHIVE" --content-type application/gzip --remote

echo "Uploading install script ..."
wrangler r2 object put "${BUCKET}/framework/install.sh" \
  --file="$ROOT/install.sh" \
  --content-type "text/x-shellscript; charset=utf-8" \
  --remote

if [ "$VERSION" != "latest" ]; then
  LATEST="$(release_object_name latest)"
  echo "Updating ${LATEST} alias ..."
  wrangler r2 object put "${BUCKET}/${LATEST}" --file="$ARCHIVE" --content-type application/gzip --remote
fi

echo ""
echo "Published:"
echo "  R2:  ${BUCKET}/${REMOTE}"
echo "  URL: https://aq.aquin.app/releases/${REMOTE}"
if [ "$VERSION" != "latest" ]; then
  echo "  URL: https://aq.aquin.app/releases/$(release_object_name latest)"
fi
