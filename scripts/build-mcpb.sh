#!/bin/bash
# Build a .mcpb bundle (Claude Desktop / MCPB Desktop Extension format) for
# the xlsx-for-ai npm package.
#
# Usage:
#   ./scripts/build-mcpb.sh             # builds for the version in package.json
#   VERSION=2.20.0 ./scripts/build-mcpb.sh   # builds for a specific version
#   SOURCE=npm ./scripts/build-mcpb.sh  # pulls from npm registry instead of local repo
#
# Output:
#   dist/xlsx-for-ai-${VERSION}.mcpb   # versioned artifact
#   dist/xlsx-for-ai.mcpb              # stable copy (latest build) — what
#                                      # gets attached to GitHub releases and
#                                      # submitted to the Anthropic directory
#
# The .mcpb is a zip of:
#   manifest.json
#   node_modules/  (production deps of the xlsx-for-ai npm package)
#
# Claude Desktop reads manifest.json, runs the entry_point as a stdio MCP
# server. No build step inside the bundle — the npm package ships JS directly.
#
# DESIGN NOTE: tool catalog is dynamic. The manifest lists tools as a guaranteed
# minimum (per MCPB spec — `tools_generated: true`). The thin client queries
# /api/v1/tools/list at runtime so new server-side tools appear without a
# .mcpb rebuild. See lib/discover.js + manifest.json `tools_generated` flag.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${SOURCE:-local}"

if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(node -p "require('${SRC_DIR}/package.json').version")"
fi

BUILD_DIR="$(mktemp -d -t mcpb-build-XXXXXX)"
OUT_DIR="${SRC_DIR}/dist"
OUT_FILE="${OUT_DIR}/xlsx-for-ai-${VERSION}.mcpb"
STABLE_FILE="${OUT_DIR}/xlsx-for-ai.mcpb"

mkdir -p "${OUT_DIR}"

echo "Building .mcpb bundle for xlsx-for-ai@${VERSION} (source=${SOURCE})"
echo "  build dir: ${BUILD_DIR}"
echo "  output:    ${OUT_FILE}"
echo "  stable:    ${STABLE_FILE}"
echo ""

# Validate the manifest before doing anything expensive.
if command -v mcpb >/dev/null 2>&1; then
  echo "Validating manifest with mcpb CLI..."
  mcpb validate "${SRC_DIR}/manifest.json"
else
  echo "WARN: mcpb CLI not installed — skipping manifest validation."
  echo "      Install with: npm install -g @anthropic-ai/mcpb"
fi

# Stage the bundle contents in an isolated dir.
cd "${BUILD_DIR}"
npm init -y > /dev/null

if [[ "${SOURCE}" == "npm" ]]; then
  # Pull from npm registry — used for shipping the published version.
  npm install "xlsx-for-ai@${VERSION}" --omit=dev --omit=optional --silent
else
  # Pull from the local repo — used during pre-publish testing so we can
  # bundle in-flight changes without publishing them.
  #
  # `npm install <path>` does NOT honor the `files` whitelist in package.json
  # (it copies the entire working tree, including .github/, test/, docs/, the
  # 30 MB optional engine in node_modules, etc.). Workaround: `npm pack` first
  # — which DOES honor `files` — then install the resulting tarball. This
  # produces a bundle byte-identical to what `SOURCE=npm` would install once
  # the version is published.
  TARBALL="$(cd "${SRC_DIR}" && npm pack --silent)"
  npm install "${SRC_DIR}/${TARBALL}" --omit=dev --omit=optional --silent
  rm -f "${SRC_DIR}/${TARBALL}"
fi

# Drop staging metadata; not part of the bundle.
rm -f package.json package-lock.json

# manifest.json — copied from the source repo, with version synced from
# package.json so the manifest version always matches the artifact version.
# Prevents the "manifest says 2.19.1 but artifact is 2.20.0" skew that
# directory submission tools reject.
cp "${SRC_DIR}/manifest.json" ./manifest.json
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('./manifest.json','utf8')); m.version='${VERSION}'; fs.writeFileSync('./manifest.json', JSON.stringify(m, null, 2) + '\n');"

# Sanity-check entry point exists.
ENTRY="node_modules/xlsx-for-ai/mcp.js"
if [[ ! -f "${ENTRY}" ]]; then
  echo "ERROR: ${ENTRY} not found in installed bundle"
  exit 1
fi

# Pack via the official mcpb CLI when available — it does the right thing
# w/r/t zip format, file ordering, and any future schema additions. Falls
# back to plain `zip` for environments without the CLI.
rm -f "${OUT_FILE}"
if command -v mcpb >/dev/null 2>&1; then
  mcpb pack . "${OUT_FILE}"
else
  zip -qrX "${OUT_FILE}" manifest.json node_modules
fi

# Verify the artifact.
unzip -tq "${OUT_FILE}"
if ! unzip -l "${OUT_FILE}" | grep -F "${ENTRY}" > /dev/null; then
  echo "ERROR: entry_point ${ENTRY} missing from zip"
  exit 1
fi

# Mirror to the stable filename so distribution surfaces (GitHub release
# attachment, Anthropic directory submission, README copy-link) point at
# a stable URL.
cp "${OUT_FILE}" "${STABLE_FILE}"

# Cleanup staging directory.
cd "${SRC_DIR}"
rm -rf "${BUILD_DIR}"

SIZE=$(du -h "${OUT_FILE}" | cut -f1)
echo ""
echo "Built ${OUT_FILE} (${SIZE})"
echo "Mirrored to ${STABLE_FILE}"
echo ""
echo "Test locally:"
echo "  open '${STABLE_FILE}' in Claude Desktop (Settings -> Extensions -> Install from file)"
echo ""
echo "After publishing the npm version, rebuild from npm to get a clean release:"
echo "  SOURCE=npm ./scripts/build-mcpb.sh"
