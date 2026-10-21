#!/usr/bin/env bash
# Build a framework tarball and publish to GitHub Releases (Aquinf03/aq).
# Requires: gh authenticated (`gh auth login`), push access to the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:?usage: release.sh <version>  e.g. 0.0.4}"
REPO="${AQUIN_GH_REPO:-Aquinf03/aq}"
TAG="v${VERSION}"

release_object_name() {
  echo "aq-${1}v.tar.gz"
}

command -v gh >/dev/null || {
  echo "gh CLI required: https://cli.github.com/ — then gh auth login" >&2
  exit 1
}

TMP="$(mktemp -d)"
VERSIONED="$TMP/$(release_object_name "$VERSION")"
LATEST="$TMP/$(release_object_name latest)"
INSTALL_COPY="$TMP/install.sh"
trap 'rm -rf "$TMP"' EXIT

echo "Building aq (TypeScript) ..."
(cd "$ROOT/aq" && npm run build)

echo "Packing tarball ..."
tar czf "$VERSIONED" -C "$ROOT" \
  --exclude='aq/node_modules' \
  --exclude='aq/kernel/.venv' \
  --exclude='aq/**/__pycache__' \
  --exclude='aq/artifacts' \
  --exclude='.git' \
  aq install.sh README.md
cp "$VERSIONED" "$LATEST"
cp "$ROOT/install.sh" "$INSTALL_COPY"

NOTES="aq ${VERSION}"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Updating existing release ${TAG} ..."
  gh release upload "$TAG" "$VERSIONED" "$LATEST" "$INSTALL_COPY" \
    --repo "$REPO" --clobber
else
  echo "Creating release ${TAG} ..."
  gh release create "$TAG" "$VERSIONED" "$LATEST" "$INSTALL_COPY" \
    --repo "$REPO" \
    --title "aq ${VERSION}" \
    --notes "$NOTES" \
    --latest
fi

echo ""
echo "Published:"
echo "  https://github.com/${REPO}/releases/tag/${TAG}"
echo "  https://github.com/${REPO}/releases/latest/download/install.sh"
echo "  https://github.com/${REPO}/releases/latest/download/$(release_object_name latest)"
echo "  https://github.com/${REPO}/releases/download/${TAG}/$(release_object_name "$VERSION")"
