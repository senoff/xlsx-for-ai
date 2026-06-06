'use strict';

// Regression test for SPM 2026-06-06 wild-adoption Fix 2
// (wild-adoption-write-schema-and-inline-errors).
//
// 4xx validation errors were collapsing to the generic "see server-side
// logs" message because friendlyErrorMessage had no `API_CLIENT_ERROR`
// branch. 3.0.8 surfaces 4xx server messages inline while keeping the
// 5xx boundary closed.
//
// TEST_PLAN cases:
//   - 4xx with server message → inline validation text appears.
//   - 4xx with absent / empty payload → graceful fallback (no `undefined`,
//     no `[object Object]`), tool name present.
//   - 5xx stays generic (discriminating case — proves we didn't
//     over-open the boundary).
//   - Known 4xx HTTP statuses (429 rate limit, 402 tier upgrade) keep
//     their specific friendly text — the new branch is the DEFAULT for
//     4xx, ordered after the specific statuses.
//   - Pre-existing client-side codes (FILE_NOT_FOUND, etc.) still match
//     their dedicated cases.

const { test } = require('node:test');
const assert = require('node:assert');
const { friendlyErrorMessage } = require('../../mcp.js');

function buildClientErr({ status, payload, message }) {
  const e = new Error(message ?? `xlsx-for-ai API error ${status}: ${payload?.error?.message ?? 'see server'}`);
  e.code = 'API_CLIENT_ERROR';
  e.status = status;
  e.payload = payload;
  return e;
}

test('4xx with structured server message → inline validation text appears', () => {
  const err = buildClientErr({
    status: 400,
    payload: { error: { code: 'bad_request', message: 'spec.sheets must be an array' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(out.includes('spec.sheets must be an array'),
    `expected inline message; got ${out}`);
  assert.ok(out.startsWith('xlsx_write:'),
    `expected tool-name prefix; got ${out}`);
});

test('4xx with flat payload.message also surfaces inline', () => {
  const err = buildClientErr({
    status: 400,
    payload: { message: 'cells[3].address is not a valid Excel address' },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(out.includes("cells[3].address is not a valid Excel address"),
    `expected inline message; got ${out}`);
});

test('4xx with empty payload → graceful fallback, no [object Object], no undefined', () => {
  const err = buildClientErr({ status: 400, payload: null });
  err.message = 'xlsx-for-ai API error 400: '; // empty after prefix
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('[object Object]'));
  assert.ok(out.includes('xlsx_write'));
});

test('4xx with absent payload entirely → graceful fallback', () => {
  const err = buildClientErr({ status: 400, payload: undefined });
  err.message = 'xlsx-for-ai API error 400: ';
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('[object Object]'));
  assert.ok(out.includes('xlsx_write'));
});

test('4xx wrapped-message fallback strips the "API error 4xx:" prefix', () => {
  const err = buildClientErr({ status: 400 });
  err.message = 'xlsx-for-ai API error 400: spec.sheets must be an array';
  err.payload = null; // forces the .message fall-through path
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(out.includes('spec.sheets must be an array'));
  assert.ok(!out.includes('API error 400'),
    `prefix should be stripped from inline message; got ${out}`);
});

test('5xx stays generic (discriminating case — security boundary preserved)', () => {
  const err = new Error('xlsx-for-ai API error 500: internal stack trace x at y:42');
  err.code = 'API_SERVER_ERROR';
  err.status = 500;
  err.payload = { error: { message: 'internal stack trace x at y:42' } };
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('internal stack trace'),
    `5xx must NOT surface payload internals; got ${out}`);
  assert.ok(out.includes('server error'),
    `5xx should return the generic server-error friendly text; got ${out}`);
});

test('429 rate-limit keeps its specific friendly text (ordering check)', () => {
  const err = buildClientErr({
    status: 429,
    payload: { error: { code: 'rate_limit_exceeded', message: 'monthly limit reached' } },
  });
  const out = friendlyErrorMessage('xlsx_read', err);
  assert.ok(out.includes('free-tier monthly cap'),
    `429 should map to RATE_LIMITED friendly text; got ${out}`);
  assert.ok(out.includes('pricing'),
    `429 friendly text should reference pricing; got ${out}`);
});

test('402 tier-upgrade keeps its specific friendly text (ordering check)', () => {
  const err = buildClientErr({
    status: 402,
    payload: { error: { code: 'tier_upgrade_required', message: 'feature requires paid tier' } },
  });
  const out = friendlyErrorMessage('xlsx_validate', err);
  assert.ok(out.includes('paid tier'),
    `402 should map to TIER_UPGRADE friendly text; got ${out}`);
});

test('pre-existing client-side codes still hit their dedicated case', () => {
  const fileNotFound = Object.assign(new Error('File not found: /abs/path/foo.xlsx'), {
    code: 'FILE_NOT_FOUND',
  });
  const out = friendlyErrorMessage('xlsx_read', fileNotFound);
  assert.equal(out, 'xlsx_read: file not found at the supplied path.');
  assert.ok(!out.includes('/abs/path/foo.xlsx'),
    'FILE_NOT_FOUND friendly text must NOT echo the path');
});

test('shapeInline4xxMessage truncates very long messages with an ellipsis', () => {
  const long = 'x'.repeat(500);
  const err = buildClientErr({ status: 400, payload: { error: { message: long } } });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(out.length < 500, `output should be bounded; got ${out.length} chars`);
  assert.ok(out.includes('…'),
    `long inline message should end with the ellipsis marker; got: ${out.slice(-10)}`);
});

test('unknown / null err → conservative generic default', () => {
  assert.equal(
    friendlyErrorMessage('xlsx_read', null),
    'xlsx_read failed — see server-side logs (request_id in response _meta) for details.'
  );
  assert.equal(
    friendlyErrorMessage('xlsx_read', undefined),
    'xlsx_read failed — see server-side logs (request_id in response _meta) for details.'
  );
});

// ---------------------------------------------------------------------------
// PII sanitizer on the 4xx inline surface (grace follow-up):
// Even though SPM scoped the inline surface to "caller's own input shape,"
// a wrapped 4xx path could carry an absolute path / email / token in
// edge cases. shapeInline4xxMessage scrubs those classes defensively.
// ---------------------------------------------------------------------------

test('PII scrubber: absolute file paths are redacted', () => {
  const err = buildClientErr({
    status: 400,
    payload: { error: { message: 'file at /Users/bob/Desktop/secrets.xlsx failed validation' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('/Users/bob/Desktop/secrets.xlsx'),
    `absolute path must be redacted; got ${out}`);
  assert.ok(out.includes('<path>'),
    `redaction placeholder expected; got ${out}`);
});

test('PII scrubber: emails are redacted', () => {
  const err = buildClientErr({
    status: 400,
    payload: { error: { message: 'user bob@example.com not found in tenant' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('bob@example.com'),
    `email must be redacted; got ${out}`);
  assert.ok(out.includes('<email>'),
    `redaction placeholder expected; got ${out}`);
});

test('PII scrubber: JWT-shaped tokens are redacted', () => {
  const err = buildClientErr({
    status: 400,
    payload: { error: { message: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c is invalid' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('eyJhbGc'),
    `JWT must be redacted; got ${out}`);
  assert.ok(out.includes('<jwt>'));
});

test('PII scrubber: Bearer auth header value is redacted', () => {
  const err = buildClientErr({
    status: 401,
    payload: { error: { message: 'unexpected auth: Bearer abc123def456ghi789jkl' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(!out.includes('abc123def456ghi789jkl'),
    `Bearer token must be redacted; got ${out}`);
  assert.ok(out.includes('<bearer>'));
});

test('PII scrubber: Slack tokens are redacted', () => {
  const err = buildClientErr({
    status: 400,
    payload: { error: { message: 'invalid token xoxb-1234567890-abcdefghij' } },
  });
  const out = friendlyErrorMessage('xlsx_post_slack', err);
  assert.ok(!out.includes('xoxb-1234567890'),
    `Slack token must be redacted; got ${out}`);
  assert.ok(out.includes('<slack-token>'));
});

test('PII scrubber: xfa_ API keys are redacted', () => {
  const err = buildClientErr({
    status: 401,
    payload: { error: { message: 'invalid key xfa_live_abc123def456ghi789jkl012' } },
  });
  const out = friendlyErrorMessage('xlsx_read', err);
  assert.ok(!out.includes('xfa_live_abc123def456ghi789jkl012'),
    `xfa key must be redacted; got ${out}`);
});

test('PII scrubber: keeps the message SHAPE while replacing payload (so the agent still gets actionable text)', () => {
  // Mixed message — some sensitive content + the validation hint the caller
  // actually needs.
  const err = buildClientErr({
    status: 400,
    payload: { error: { message: 'spec.sheets[0].cells[3].address /Users/bob/file.xlsx is not a valid Excel address' } },
  });
  const out = friendlyErrorMessage('xlsx_write', err);
  assert.ok(out.includes('spec.sheets[0].cells[3].address'),
    `caller-actionable signal must survive scrubbing; got ${out}`);
  assert.ok(out.includes('not a valid Excel address'));
  assert.ok(!out.includes('/Users/bob/file.xlsx'));
});

// ---------------------------------------------------------------------------
// xlsx_write schema-level rules (grace follow-up):
// ---------------------------------------------------------------------------

test('xlsx_write schema does NOT require out_path (bytes-return path is supported)', () => {
  const { TOOLS } = require('../../mcp.js');
  const writeTool = TOOLS.find((t) => t.name === 'xlsx_write');
  // Required can be undefined OR an array that does not include out_path.
  const required = writeTool.inputSchema.required;
  if (Array.isArray(required)) {
    assert.ok(!required.includes('out_path'),
      `out_path should not be required (the bytes-return path needs no path); got ${JSON.stringify(required)}`);
  }
});

test('xlsx_write cells enforce value-XOR-formula via oneOf', () => {
  const { TOOLS } = require('../../mcp.js');
  const writeTool = TOOLS.find((t) => t.name === 'xlsx_write');
  const cell = writeTool.inputSchema.properties.spec.properties.sheets.items.properties.cells.items;
  assert.ok(Array.isArray(cell.oneOf), 'cell.oneOf must be set');
  assert.equal(cell.oneOf.length, 2,
    'oneOf should have exactly two branches: value-only or formula-only');
});

test('xlsx_write formula property has a no-leading-= pattern', () => {
  const { TOOLS } = require('../../mcp.js');
  const writeTool = TOOLS.find((t) => t.name === 'xlsx_write');
  const formula = writeTool.inputSchema.properties.spec.properties.sheets.items
    .properties.cells.items.properties.formula;
  assert.ok(typeof formula.pattern === 'string',
    'formula.pattern must be set to enforce the no-leading-= rule');
  // Sanity-check the pattern actually rejects `=` and accepts a bare expr.
  const re = new RegExp(formula.pattern);
  assert.ok(!re.test('=SUM(A1:A10)'),
    'formula pattern should reject leading "="');
  assert.ok(re.test('SUM(A1:A10)'),
    'formula pattern should accept bare expression');
});

test('xlsx_write value property declares the union of allowed primitive types', () => {
  const { TOOLS } = require('../../mcp.js');
  const writeTool = TOOLS.find((t) => t.name === 'xlsx_write');
  const value = writeTool.inputSchema.properties.spec.properties.sheets.items
    .properties.cells.items.properties.value;
  assert.ok(Array.isArray(value.type),
    'value.type should be an array of allowed primitive types');
  assert.ok(value.type.includes('string'));
  assert.ok(value.type.includes('number'));
  assert.ok(value.type.includes('boolean'));
  assert.ok(value.type.includes('null'));
});
