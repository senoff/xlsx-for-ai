#!/usr/bin/env node
'use strict';

/**
 * scripts/build-manifests.js — MCP tools/list snapshot generator.
 *
 * Inputs (source of truth):
 *   - mcp.js TOOLS array            — name + description + inputSchema
 *   - lib/annotations.js            — title + readOnlyHint + destructiveHint
 *
 * Output:
 *   dist/mcp-tools.json             — full MCP tools/list snapshot, used as
 *   the `mcp_tool_description` ref in MSFT's plugin manifest 2.4
 *   (RemoteMCPServer runtime). Includes annotations.
 *
 * Usage:
 *   node scripts/build-manifests.js            # write the snapshot
 *
 * On-demand only: regenerate when TOOLS or annotations change. The output
 * lives under dist/ (gitignored build artifact), so there is no committed
 * copy to drift against.
 */

const fs   = require('fs');
const path = require('path');

const { TOOLS }              = require('../mcp.js');
const { applyAnnotations }   = require('../lib/annotations.js');

const ROOT = path.join(__dirname, '..');
const MCP_TOOLS_PATH   = path.join(ROOT, 'dist', 'mcp-tools.json');

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

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  const snapshot = { tools: buildMcpToolsSnapshot() };
  writeJson(MCP_TOOLS_PATH, snapshot);
  console.log(`wrote ${path.relative(ROOT, MCP_TOOLS_PATH)} (${snapshot.tools.length} tools)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMcpToolsSnapshot,
};
