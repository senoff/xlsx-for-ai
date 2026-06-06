'use strict';

// Regression test for SPM P0 2026-06-05
// (p0-client-floor-8-annotations-plus-phase2-proceed).
//
// Every tool the MCP server exposes MUST carry an entry in the client-side
// baked `TOOL_ANNOTATIONS` map. Until the server-side annotations theme
// reaches production, the client's baked map is the floor — anything not in
// it ships through `applyAnnotations` UNCHANGED (no title, no readOnlyHint,
// no destructiveHint). Claude Desktop's permission panel then renders those
// tools as bare names instead of titled / bucketed rows. Bob's morning panel
// hit exactly that with the 8 originally-missing entries (4 healer + 2
// receipt + read_handle + session_set_validations).
//
// This test pins the invariant. The next tool added to TOOLS without a
// matching TOOL_ANNOTATIONS entry fails the test before publish.

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../../mcp.js');
const { TOOL_ANNOTATIONS, applyAnnotations } = require('../../lib/annotations');

test('every TOOLS entry has a matching TOOL_ANNOTATIONS entry', () => {
  const missing = TOOLS
    .map((t) => t.name)
    .filter((name) => !TOOL_ANNOTATIONS[name]);
  assert.equal(
    missing.length,
    0,
    `TOOLS entries missing from TOOL_ANNOTATIONS:\n  ${missing.join('\n  ')}\n` +
      `Add an entry in lib/annotations.js (title + readOnlyHint + destructiveHint) ` +
      `to keep the Desktop permission panel from rendering bare tool names.`
  );
});

test('applyAnnotations: every TOOLS entry emerges with annotations.title set', () => {
  // End-to-end shape check: what reaches the wire after applyAnnotations
  // must have annotations.title for the Desktop panel to title each row.
  const emitted = applyAnnotations(TOOLS);
  const naked = emitted.filter(
    (t) => !t.annotations || typeof t.annotations.title !== 'string' || !t.annotations.title
  );
  assert.equal(
    naked.length,
    0,
    `Tools whose emitted shape lacks annotations.title:\n  ${naked.map((t) => t.name).join('\n  ')}`
  );
});

test('applyAnnotations: every TOOLS entry has a defined readOnlyHint', () => {
  // The hint must be present (true OR false), not undefined. Desktop uses
  // it to bucket read-only vs. write actions in the panel.
  const emitted = applyAnnotations(TOOLS);
  const missing = emitted.filter(
    (t) => !t.annotations || typeof t.annotations.readOnlyHint !== 'boolean'
  );
  assert.equal(
    missing.length,
    0,
    `Tools whose emitted shape lacks a boolean annotations.readOnlyHint:\n  ${missing
      .map((t) => t.name)
      .join('\n  ')}`
  );
});
