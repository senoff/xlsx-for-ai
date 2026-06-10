'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildMcpToolsSnapshot,
} = require('../../scripts/build-manifests.js');
const { TOOLS } = require('../../mcp.js');

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
