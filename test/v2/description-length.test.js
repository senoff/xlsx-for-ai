'use strict';

// Regression test for SPM P0 2026-06-05
// (desktop-drops-7-tools-description-length-cap).
//
// Claude Desktop enforces an undocumented per-tool description-length cap
// at ~1200 chars in the protocol version Bob's client speaks today (2025-11-25).
// Any tool whose description exceeds the cap is silently dropped from the
// Tool permissions panel — schema correctness alone is not enough.
//
// 3.0.3 sets a hard budget of 1024 chars (round binary, 18% safety margin
// under the observed cliff) and asserts it here so a future authoring pass
// (the rich-description theme on the server side, or any ad-hoc
// description edit) can't regress past it without the test catching it.

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../../mcp.js');

const BUDGET_CHARS = 1024;

test('every TOOLS entry has a description under the Desktop cap budget', () => {
  const violations = [];
  for (const tool of TOOLS) {
    const len = (tool.description || '').length;
    if (len > BUDGET_CHARS) {
      violations.push({ name: tool.name, len, excess: len - BUDGET_CHARS });
    }
  }
  assert.equal(
    violations.length,
    0,
    `Description budget violations (>${BUDGET_CHARS} chars):\n` +
      violations
        .sort((a, b) => b.len - a.len)
        .map((v) => `  ${v.name}: ${v.len} chars (excess: ${v.excess})`)
        .join('\n') +
      '\n\nClaude Desktop silently drops tools whose description exceeds an ~1200-char cap. ' +
      'Trim the description; consider removing brand boilerplate or competitive framing first.'
  );
});

test('every TOOLS entry has a non-empty description (Claude Desktop requirement)', () => {
  const missing = TOOLS.filter((t) => !t.description || t.description.length === 0).map(
    (t) => t.name
  );
  assert.equal(
    missing.length,
    0,
    `Tools with empty/missing description: ${missing.join(', ')}`
  );
});
