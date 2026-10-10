'use strict';

// XLS-849 — the GENERATED tool floor is wired into the baked catalog and is
// structurally complete. This is the no-network half of the drift guard: it
// proves the committed floor satisfies every invariant the client and Claude
// Desktop require. The live half (baked names == live inventory) is
// `node scripts/gen-tool-floor.js --check`, run in CI before publish.
//
// Why this matters: the baked floor is the cold-start ceiling (no network, no
// cache) AND — because /api/v1/tools/list carries no `description` on the wire —
// mergeTools fills each tool's description from this floor even ONLINE. A tool
// missing here reaches the agent description-less, which Desktop silently drops.

const { test } = require('node:test');
const assert = require('node:assert');

const { TOOLS } = require('../../mcp.js');
const { TOOL_ANNOTATIONS, applyAnnotations } = require('../../lib/annotations');
const { diffFloor, bakedNames } = require('../../scripts/gen-tool-floor.js');
const {
  GENERATED_FLOOR_TOOLS,
  GENERATED_FLOOR_ANNOTATIONS,
} = require('../../generated/tool-floor.generated.js');

const BUDGET_CHARS = 1024; // same Desktop description cap as description-length.test.js

test('the generated floor is appended to the baked TOOLS catalog', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  const missing = GENERATED_FLOOR_TOOLS.map((t) => t.name).filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `generated floor tools absent from baked TOOLS: ${missing.join(', ')}`);
});

test('the funnel producers + pii/vault scans are present in the baked floor', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  // Representative tools that were missing from the hand-frozen 50-tool floor.
  for (const n of [
    'shopify_products_import',
    'printful_catalog_pull',
    'shopify_google_feed',
    'xlsx_pii_scan',
    'xlsx_vault_scan',
  ]) {
    assert.ok(names.has(n), `expected ${n} in the baked floor`);
  }
});

test('every generated floor tool has a non-empty, capped description and an object inputSchema', () => {
  for (const t of GENERATED_FLOOR_TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.description && t.description.length > 0, `${t.name}: empty description`);
    assert.ok(t.description.length <= BUDGET_CHARS, `${t.name}: description ${t.description.length} > ${BUDGET_CHARS}`);
    assert.equal(typeof t.inputSchema, 'object', `${t.name}: inputSchema not an object`);
    assert.ok(t.inputSchema !== null, `${t.name}: inputSchema is null`);
  }
});

test('every baked tool carries a matching annotation (base + generated overlay)', () => {
  const missing = TOOLS.map((t) => t.name).filter((n) => !TOOL_ANNOTATIONS[n]);
  assert.deepEqual(missing, [], `baked tools missing from TOOL_ANNOTATIONS: ${missing.join(', ')}`);
});

test('applyAnnotations emits a title + boolean readOnlyHint for every baked tool', () => {
  const emitted = applyAnnotations(TOOLS);
  const naked = emitted.filter(
    (t) => !t.annotations || typeof t.annotations.title !== 'string' || !t.annotations.title,
  );
  assert.deepEqual(naked.map((t) => t.name), [], 'tools whose emitted shape lacks annotations.title');
  const noHint = emitted.filter((t) => !t.annotations || typeof t.annotations.readOnlyHint !== 'boolean');
  assert.deepEqual(noHint.map((t) => t.name), [], 'tools whose emitted shape lacks a boolean readOnlyHint');
});

test('generated floor tools and annotations cover the same name set', () => {
  const toolNames = GENERATED_FLOOR_TOOLS.map((t) => t.name).sort();
  const annNames = Object.keys(GENERATED_FLOOR_ANNOTATIONS).sort();
  assert.deepEqual(annNames, toolNames, 'generated tools/annotations name-set mismatch');
});

// ---------------------------------------------------------------------------
// XLS-979 — the drift PREDICATE has teeth (the mutation proof).
//
// `node scripts/gen-tool-floor.js --check` guards floor-content drift by diffing
// LIVE inventory against the baked floor. That live half needs the network. This
// no-network mutation proof exercises the SAME predicate (`diffFloor`, factored
// out of `check()`) against the REAL baked floor so a standing per-push run
// proves the guard actually REDs when inventory gains a tool the floor lacks —
// the exact silent-ship the card names. Without a positive control, a check that
// can never fail is indistinguishable from one that always passes.
// ---------------------------------------------------------------------------

test('XLS-979 negative control — the real baked floor vs itself reports NO drift', () => {
  const baked = bakedNames();
  const { drift, missingFromFloor, staleInFloor } = diffFloor(baked, baked);
  assert.equal(drift, false, 'floor diffed against itself must be drift-free');
  assert.deepEqual(missingFromFloor, []);
  assert.deepEqual(staleInFloor, []);
});

test('XLS-979 positive control (mutation) — a tool added to inventory without a floor regen REDs', () => {
  const baked = bakedNames();
  // Simulate the server growing its TOOL_INVENTORY by one tool while the baked
  // floor is untouched (no `tool-floor:generate` run) — the silent-ship the
  // standing check must catch.
  const liveWithNewTool = [...baked, 'xlsx_a_new_untiered_tool'];
  const { drift, missingFromFloor } = diffFloor(liveWithNewTool, baked);
  assert.equal(drift, true, 'a live tool absent from the floor MUST register as drift');
  assert.deepEqual(missingFromFloor, ['xlsx_a_new_untiered_tool']);
});

test('XLS-979 stale control (mutation) — a floor tool dropped from inventory REDs', () => {
  const baked = bakedNames();
  assert.ok(baked.size > 0, 'baked floor unexpectedly empty — the mutation proof needs a real tool to drop');
  const dropped = [...baked][0];
  const liveMinusOne = [...baked].filter((n) => n !== dropped);
  const { drift, staleInFloor } = diffFloor(liveMinusOne, baked);
  assert.equal(drift, true, 'a baked tool no longer live MUST register as drift');
  assert.deepEqual(staleInFloor, [dropped]);
});
