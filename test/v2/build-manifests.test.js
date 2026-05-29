'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildMcpbTools,
  buildMcpToolsSnapshot,
  regenerateManifest,
} = require('../../scripts/build-manifests.js');
const { TOOLS } = require('../../mcp.js');

test('buildMcpbTools returns one entry per TOOL with slim shape', () => {
  const out = buildMcpbTools();
  assert.equal(out.length, TOOLS.length, 'one MCPB entry per TOOLS source entry');
  for (const t of out) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 0);
    // No inputSchema or annotations in MCPB manifest — those are fetched
    // live by Claude Desktop at runtime
    assert.equal(t.inputSchema, undefined);
    assert.equal(t.annotations, undefined);
  }
});

test('buildMcpToolsSnapshot returns full MCP shape with annotations', () => {
  const out = buildMcpToolsSnapshot();
  assert.equal(out.length, TOOLS.length);
  for (const t of out) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.inputSchema, 'object');
  }
  // Spot-check annotations flow through
  const read = out.find((t) => t.name === 'xlsx_read');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.annotations.destructiveHint, false);
  const post = out.find((t) => t.name === 'xlsx_post_slack');
  assert.equal(post.annotations.destructiveHint, true);
});

test('regenerateManifest preserves all non-tool fields', () => {
  const existing = {
    manifest_version: '0.3',
    name: 'xlsx-for-ai',
    version: '9.9.9',
    description: 'desc',
    server: { type: 'node', entry_point: 'foo' },
    tools_generated: true,
    tools: [{ name: 'OLD', description: 'stale' }],
  };
  const out = regenerateManifest(existing);
  // Non-tool fields unchanged
  assert.equal(out.manifest_version, '0.3');
  assert.equal(out.name, 'xlsx-for-ai');
  assert.equal(out.version, '9.9.9');
  assert.equal(out.description, 'desc');
  assert.deepEqual(out.server, { type: 'node', entry_point: 'foo' });
  assert.equal(out.tools_generated, true);
  // Tools rebuilt from source-of-truth
  assert.equal(out.tools.length, TOOLS.length);
  assert.equal(out.tools.find((t) => t.name === 'OLD'), undefined, 'stale tools dropped');
  assert.ok(out.tools.find((t) => t.name === 'xlsx_data_clean'), 'xlsx_data_clean now present (was missing)');
});

test('regenerateManifest is idempotent on repeat application', () => {
  const seed = { manifest_version: '0.3', tools: [] };
  const once = regenerateManifest(seed);
  const twice = regenerateManifest(once);
  assert.deepEqual(once, twice);
});
