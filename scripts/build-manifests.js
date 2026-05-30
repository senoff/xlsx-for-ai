#!/usr/bin/env node
'use strict';

/**
 * scripts/build-manifests.js — single-source manifest regeneration.
 *
 * Inputs (source of truth):
 *   - mcp.js TOOLS array            — name + description + inputSchema
 *   - lib/annotations.js            — title + readOnlyHint + destructiveHint
 *
 * Outputs:
 *   1. manifest.json (MCPB bundle)  — regenerates the `tools` array as the
 *      compact {name, description} shape Claude Desktop's MCPB loader uses.
 *      All other fields preserved.
 *   2. dist/mcp-tools.json          — full MCP tools/list snapshot, used as
 *      the `mcp_tool_description` ref in MSFT's plugin manifest 2.4
 *      (RemoteMCPServer runtime). Includes annotations.
 *
 * Usage:
 *   node scripts/build-manifests.js            # write outputs in place
 *   node scripts/build-manifests.js --check    # exit 1 if outputs would change
 *
 * Rationale:
 *   Drift between mcp.js TOOLS and manifest.json was real (xlsx_data_clean
 *   missing from manifest). One source, one script, one read of source of
 *   truth — every consumer regenerates rather than maintaining its own copy.
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');

const { TOOLS }              = require('../mcp.js');
const { applyAnnotations }   = require('../lib/annotations.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH    = path.join(ROOT, 'manifest.json');
const MCP_TOOLS_PATH   = path.join(ROOT, 'dist', 'mcp-tools.json');

function buildMcpbTools() {
  // MCPB manifest uses the slim {name, description} shape. inputSchema and
  // annotations are NOT carried here — Claude Desktop fetches them live
  // from the MCP server at runtime (tools_generated: true).
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

function buildMcpToolsSnapshot() {
  // Full MCP tools/list shape: name + description + inputSchema + annotations.
  // This is what MSFT's plugin manifest 2.4 references via
  // RemoteMCPServer.spec.mcp_tool_description.
  return applyAnnotations(
    TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  );
}

function regenerateManifest(existing) {
  // Preserve every field except `tools` — that gets rebuilt from TOOLS.
  return { ...existing, tools: buildMcpbTools() };
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Structural deep equality (not JSON.stringify) so key-order differences
// don't trigger false drift on round-tripped objects.
const jsonEqual = util.isDeepStrictEqual;

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');

  const currentManifest = readJson(MANIFEST_PATH);
  const newManifest     = regenerateManifest(currentManifest);
  const newSnapshot     = { tools: buildMcpToolsSnapshot() };

  let drift = false;
  if (!jsonEqual(currentManifest, newManifest)) {
    drift = true;
    if (!checkOnly) {
      writeJson(MANIFEST_PATH, newManifest);
      console.log(`wrote manifest.json (${newManifest.tools.length} tools)`);
    } else {
      console.error('manifest.json drift detected:');
      const before = new Set(currentManifest.tools.map((t) => t.name));
      const after  = new Set(newManifest.tools.map((t) => t.name));
      for (const n of after) if (!before.has(n)) console.error(`  + ${n}`);
      for (const n of before) if (!after.has(n)) console.error(`  - ${n}`);
    }
  } else if (!checkOnly) {
    console.log(`manifest.json already in sync (${newManifest.tools.length} tools)`);
  }

  // mcp-tools.json lives under dist/ (gitignored build artifact). --check is
  // about catching forgotten regenerations of committed sources; a missing
  // build artifact is the normal state on a fresh checkout (CI, new clone),
  // not drift. Only flag drift when the file exists AND differs.
  let snapshotChanged = false;
  const snapshotExists = fs.existsSync(MCP_TOOLS_PATH);
  if (snapshotExists) {
    const current = readJson(MCP_TOOLS_PATH);
    if (!jsonEqual(current, newSnapshot)) snapshotChanged = true;
  }

  if (snapshotChanged || (!snapshotExists && !checkOnly)) {
    if (snapshotChanged) drift = true;
    if (!checkOnly) {
      writeJson(MCP_TOOLS_PATH, newSnapshot);
      console.log(`wrote ${path.relative(ROOT, MCP_TOOLS_PATH)} (${newSnapshot.tools.length} tools)`);
    } else {
      console.error(`${path.relative(ROOT, MCP_TOOLS_PATH)} would be rewritten`);
    }
  } else if (!checkOnly) {
    console.log(`${path.relative(ROOT, MCP_TOOLS_PATH)} already in sync`);
  }

  if (checkOnly && drift) {
    console.error('\nRun `node scripts/build-manifests.js` to regenerate.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMcpbTools,
  buildMcpToolsSnapshot,
  regenerateManifest,
};
