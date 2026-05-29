'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TOOL_ANNOTATIONS, applyAnnotations } = require('../../lib/annotations');

// Canonical surfaced-tool list. Update this if a tool is added to or removed
// from the MCP surface. Drives both the count assertion and the set-equality
// check that follows — so a tool swap (e.g., rename without ann map update)
// can't pass by keeping the count constant.
const EXPECTED_TOOL_NAMES = new Set([
  'xlsx_read', 'xlsx_list_sheets', 'xlsx_schema', 'xlsx_diff',
  'xlsx_describe', 'xlsx_filter', 'xlsx_aggregate', 'xlsx_named_ranges',
  'xlsx_sort', 'xlsx_value_counts', 'xlsx_formulas', 'xlsx_tables',
  'xlsx_pivot', 'xlsx_eval', 'xlsx_validate', 'xlsx_data_validations',
  'xlsx_hyperlinks', 'xlsx_topology', 'xlsx_conditional_formats',
  'xlsx_comments', 'xlsx_doctor', 'xlsx_form_controls', 'xlsx_macros',
  'xlsx_merged_cells', 'xlsx_workbook_views', 'xlsx_print_settings',
  'xlsx_properties', 'xlsx_external_links', 'xlsx_slicers_timelines',
  'xlsx_pivot_tables', 'xlsx_images', 'xlsx_charts', 'xlsx_protection',
  'xlsx_styles', 'xlsx_verify_stamp',
  'xlsx_write', 'xlsx_redact', 'xlsx_convert', 'xlsx_data_clean', 'xlsx_stamp',
  'xlsx_post_slack', 'xlsx_post_teams',
]);

test('TOOL_ANNOTATIONS matches the canonical surfaced-tool list exactly', () => {
  const actual = new Set(Object.keys(TOOL_ANNOTATIONS));
  assert.deepEqual(actual, EXPECTED_TOOL_NAMES);
  // Spot-check classification
  assert.equal(TOOL_ANNOTATIONS.xlsx_read.readOnlyHint, true);
  assert.equal(TOOL_ANNOTATIONS.xlsx_read.destructiveHint, false);
  assert.equal(TOOL_ANNOTATIONS.xlsx_write.readOnlyHint, false);
  assert.equal(TOOL_ANNOTATIONS.xlsx_write.destructiveHint, false, 'write is Save-As shape — not destructive');
  assert.equal(TOOL_ANNOTATIONS.xlsx_post_slack.destructiveHint, true, 'external posts cannot be undone');
  assert.equal(TOOL_ANNOTATIONS.xlsx_post_teams.destructiveHint, true, 'external posts cannot be undone');
});

test('every annotation has the three required fields', () => {
  for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
    assert.equal(typeof ann.title, 'string', `${name}: title must be string`);
    assert.ok(ann.title.length > 0, `${name}: title must be non-empty`);
    assert.equal(typeof ann.readOnlyHint, 'boolean', `${name}: readOnlyHint must be boolean`);
    assert.equal(typeof ann.destructiveHint, 'boolean', `${name}: destructiveHint must be boolean`);
  }
});

test('readOnlyHint and destructiveHint cannot both be true (incoherent)', () => {
  for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
    assert.ok(
      !(ann.readOnlyHint && ann.destructiveHint),
      `${name}: a read-only tool cannot also be destructive`
    );
  }
});

test('applyAnnotations overlays annotations onto matching tools', () => {
  const input = [
    { name: 'xlsx_read', description: 'd', inputSchema: { type: 'object' } },
    { name: 'xlsx_post_slack', description: 'd', inputSchema: { type: 'object' } },
  ];
  const out = applyAnnotations(input);

  assert.equal(out.length, 2);
  assert.equal(out[0].annotations.title, 'Read Excel file');
  assert.equal(out[0].annotations.readOnlyHint, true);
  assert.equal(out[0].annotations.destructiveHint, false);
  assert.equal(out[1].annotations.destructiveHint, true);

  // Original fields preserved
  assert.equal(out[0].name, 'xlsx_read');
  assert.equal(out[0].description, 'd');
  assert.deepEqual(out[0].inputSchema, { type: 'object' });
});

test('applyAnnotations does not mutate the input array or its tools', () => {
  const tool = { name: 'xlsx_read', description: 'd' };
  const input = [tool];
  const out = applyAnnotations(input);

  assert.notEqual(out, input, 'returns a new array');
  assert.notEqual(out[0], tool, 'returns new tool objects');
  assert.equal(tool.annotations, undefined, 'original tool is not mutated');
});

test('applyAnnotations passes through tools without a known annotation', () => {
  const input = [
    { name: 'xlsx_unknown_future_tool', description: 'd' },
  ];
  const out = applyAnnotations(input);

  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'xlsx_unknown_future_tool');
  assert.equal(out[0].annotations, undefined, 'unknown tools are not annotated');
});

test('applyAnnotations preserves existing per-tool annotations on collision', () => {
  // If a remote source already carries an annotation, that wins over our overlay
  // for the same key — the overlay only fills gaps.
  const input = [
    {
      name: 'xlsx_read',
      annotations: { title: 'Remote-supplied title', idempotentHint: true },
    },
  ];
  const out = applyAnnotations(input);

  assert.equal(out[0].annotations.title, 'Remote-supplied title');
  assert.equal(out[0].annotations.idempotentHint, true);
  // Fields the remote didn't supply still come from our overlay
  assert.equal(out[0].annotations.readOnlyHint, true);
  assert.equal(out[0].annotations.destructiveHint, false);
});

test('applyAnnotations tolerates malformed input', () => {
  assert.deepEqual(applyAnnotations(null), null);
  assert.deepEqual(applyAnnotations(undefined), undefined);
  assert.deepEqual(applyAnnotations([]), []);
  const malformed = [{ /* no name */ }, null, { name: 123 }];
  const out = applyAnnotations(malformed);
  assert.equal(out.length, 3, 'malformed entries pass through');
});

test('applyAnnotations rejects prototype-pollution keys from upstream annotations', () => {
  const hostile = [{
    name: 'xlsx_read',
    annotations: {
      idempotentHint: true,
      __proto__: { polluted: true },
      constructor: { polluted: true },
      prototype: { polluted: true },
    },
  }];
  const out = applyAnnotations(hostile);

  assert.equal(out[0].annotations.idempotentHint, true, 'safe keys still pass through');
  assert.equal(out[0].annotations.polluted, undefined, 'pollution keys do not survive merge');
  assert.equal(Object.getPrototypeOf(out[0].annotations), Object.prototype, 'prototype is unchanged');
  assert.equal(({}).polluted, undefined, 'Object.prototype itself is unmodified');
});

test('applyAnnotations ignores non-plain-object annotation values', () => {
  const inputs = [
    { name: 'xlsx_read', annotations: [1, 2, 3] },    // array
    { name: 'xlsx_read', annotations: 'string' },     // primitive
    { name: 'xlsx_read', annotations: null },         // null
  ];
  for (const t of inputs) {
    const out = applyAnnotations([t]);
    // Falls back to canonical annotation only
    assert.equal(out[0].annotations.title, 'Read Excel file');
    assert.equal(out[0].annotations.readOnlyHint, true);
  }
});
