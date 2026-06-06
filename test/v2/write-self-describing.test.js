'use strict';

// Regression test for SPM 2026-06-06 wild-adoption Fix 1
// (wild-adoption-write-schema-and-inline-errors).
//
// Live testing by a non-Bob Claude agent guessed wrong twice on xlsx_write
// because the spec param shape was just `{type:'object'}` with no nested
// description. 3.0.8 declares the full nested shape + an inline example +
// the value-XOR-formula + no-leading-`=` rules. This test pins the shape
// so a future refactor can't silently revert.

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../../mcp.js');

const writeTool = TOOLS.find((t) => t.name === 'xlsx_write');

test('xlsx_write spec inputSchema declares the nested sheets/cells shape', () => {
  assert.ok(writeTool, 'xlsx_write tool not found');
  const spec = writeTool.inputSchema.properties.spec;
  assert.ok(spec, 'spec property missing from inputSchema');
  assert.equal(spec.type, 'object');
  // spec must require `sheets`.
  assert.deepEqual(spec.required, ['sheets']);
  // sheets is an array of {name, cells} objects.
  const sheets = spec.properties.sheets;
  assert.equal(sheets.type, 'array');
  assert.equal(sheets.items.type, 'object');
  assert.ok(sheets.items.required.includes('name'));
  assert.ok(sheets.items.required.includes('cells'));
  // cells items declare A1-style address + value | formula.
  const cell = sheets.items.properties.cells.items;
  assert.ok(cell.required.includes('address'));
  assert.equal(cell.properties.address.pattern, '^[A-Za-z]+\\d+$');
  assert.ok(cell.properties.value, 'cell.value missing');
  assert.ok(cell.properties.formula, 'cell.formula missing');
});

test('xlsx_write spec description carries the minimal inline example', () => {
  const spec = writeTool.inputSchema.properties.spec;
  assert.ok(typeof spec.description === 'string');
  // Must reference both the value-XOR-formula rule + the no-leading-`=`
  // rule so a model reading just the description can construct a correct
  // call.
  assert.ok(/formula.*no.*=|no leading.*=|WITHOUT leading "="/i.test(spec.description),
    'description must call out "formula has NO leading =" rule');
  assert.ok(/value|formula/.test(spec.description),
    'description must mention value | formula choice');
  // Must include a concrete example with both a value and a formula cell.
  assert.ok(spec.description.includes('"address":"A1"'),
    'description must include an inline address example');
  assert.ok(spec.description.includes('"formula"'),
    'description must include a formula example');
});

test('xlsx_write tool description also enriched (one-shot from description alone)', () => {
  // The tool-level description should also surface the spec shape so a
  // client that doesn't render nested inputSchema descriptions still gets
  // the example.
  assert.ok(writeTool.description.includes('sheets'));
  assert.ok(writeTool.description.includes('cells'));
  assert.ok(writeTool.description.includes('address'));
  // Stays under the 1024-char Claude Desktop cap.
  assert.ok(writeTool.description.length <= 1024,
    `xlsx_write description ${writeTool.description.length} > 1024 char cap`);
});
