#!/bin/bash
# Build a .mcpb bundle (Claude Desktop / MCPB extension format) for the
# currently-published xlsx-for-ai npm package.
#
# Usage:
#   ./scripts/build-mcpb.sh             # builds for the npm "latest" version
#   VERSION=2.1.0 ./scripts/build-mcpb.sh   # builds for a specific version
#
# Output: dist/xlsx-for-ai-${VERSION}.mcpb
#
# The .mcpb is just a zip of:
#   manifest.json
#   node_modules/  (production deps of the xlsx-for-ai npm package)
#
# Claude Desktop reads manifest.json, runs the entry_point as a stdio MCP
# server. No build step inside the bundle — the npm package ships JS directly.

set -euo pipefail

VERSION="${VERSION:-$(npm view xlsx-for-ai version)}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d -t mcpb-build-XXXXXX)"
OUT_DIR="${SRC_DIR}/dist"
OUT_FILE="${OUT_DIR}/xlsx-for-ai-${VERSION}.mcpb"

mkdir -p "${OUT_DIR}"

echo "Building .mcpb bundle for xlsx-for-ai@${VERSION}"
echo "  build dir: ${BUILD_DIR}"
echo "  output:    ${OUT_FILE}"
echo ""

# Stage a fresh production-deps install in an isolated dir so the bundle
# only carries what the runtime needs.
cd "${BUILD_DIR}"
npm init -y > /dev/null
npm install "xlsx-for-ai@${VERSION}" --production --silent

# Drop the staging package.json/lock — they aren't part of the bundle.
rm -f package.json package-lock.json

# manifest.json — copied from the source repo so any edits flow through here.
cp "${SRC_DIR}/manifest.json" ./manifest.json

# Sanity check entry point exists.
ENTRY="node_modules/xlsx-for-ai/mcp.js"
if [[ ! -f "${ENTRY}" ]]; then
  echo "ERROR: ${ENTRY} not found in installed bundle"
  exit 1
fi

# Zip everything → .mcpb. -X strips Apple metadata; -r recurses; -q quiet.
rm -f "${OUT_FILE}"
zip -qrX "${OUT_FILE}" manifest.json node_modules

# Quick verification — make sure it's a valid zip and the entry point survived.
unzip -tq "${OUT_FILE}"
if ! unzip -l "${OUT_FILE}" | grep -F "${ENTRY}" > /dev/null; then
  echo "ERROR: entry_point ${ENTRY} missing from zip"
  exit 1
fi

# Cleanup staging directory.
cd "${SRC_DIR}"
rm -rf "${BUILD_DIR}"

SIZE=$(du -h "${OUT_FILE}" | cut -f1)
echo ""
echo "✓ Built ${OUT_FILE} (${SIZE})"
echo ""
echo "Test locally: open ${OUT_FILE} in Claude Desktop (Settings → Extensions → drag-drop)."
echo "Distribute via: GitHub release attachment + linked from README."
