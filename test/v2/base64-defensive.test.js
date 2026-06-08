'use strict';

// Regression tests for SPM SPEC 2026-06-07
// (base64-defensive-error-and-suggested-next-call).
//
// Two belt-and-suspenders behaviors on top of the 3.0.14 description
// hardening:
//   1. Defensive validation in dispatchTool — bytes-shaped argument where
//      a file_path is expected throws a friendly error code, so the model
//      gets a one-turn recovery instead of an indefinite base64-bash-hang.
//   2. Drill-down suggestions in tool outputs — concrete invocations with
//      file_path pre-filled, so the next call inherits a correct-usage
//      exemplar.

const { test } = require('node:test');
const assert = require('node:assert');
const { friendlyErrorMessage } = require('../../mcp.js');

// ---------------------------------------------------------------------------
// friendlyErrorMessage — BASE64_MISREAD + MISSING_REQUIRED_ARG codes
// ---------------------------------------------------------------------------

function buildErr(code, field, message) {
  const e = new Error(message || `synthetic ${code}`);
  e.code = code;
  if (field) e.field = field;
  return e;
}

test('BASE64_MISREAD surfaces the offending field name + path-string hint', () => {
  const err = buildErr('BASE64_MISREAD', 'file_path');
  const out = friendlyErrorMessage('xlsx_doctor', err);
  assert.ok(out.includes('xlsx_doctor'));
  assert.ok(out.includes('file_path'));
  assert.ok(out.includes('PATH STRING'), `expected path-string hint; got ${out}`);
  assert.ok(out.includes('Retry'), 'should tell the model to retry');
});

test('BASE64_MISREAD falls back to "file_path" when field is missing', () => {
  const err = buildErr('BASE64_MISREAD');
  const out = friendlyErrorMessage('xlsx_read', err);
  assert.ok(out.includes('file_path'));
});

test('MISSING_REQUIRED_ARG names the missing field', () => {
  const err = buildErr('MISSING_REQUIRED_ARG', 'file_path');
  const out = friendlyErrorMessage('xlsx_doctor', err);
  assert.ok(out.includes('missing required argument'));
  assert.ok(out.includes('"file_path"'));
});

test('MISSING_REQUIRED_ARG mentions the workhorse file_path-as-string contract', () => {
  const err = buildErr('MISSING_REQUIRED_ARG', 'file_path');
  const out = friendlyErrorMessage('xlsx_doctor', err);
  assert.ok(out.includes('path string'));
  assert.ok(out.includes('NOT bytes'));
});

// ---------------------------------------------------------------------------
// Defensive validation — calling dispatchTool with bytes / missing args
// ---------------------------------------------------------------------------

const { dispatchTool } = require('../../mcp.js');

// Helper — assert dispatch fails synchronously with the expected code.
async function expectDispatchFails(name, args, expectedCode) {
  let caught;
  try {
    await dispatchTool(name, args);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected dispatchTool to throw on ${name}`);
  assert.equal(caught.code, expectedCode, `wrong error code: ${caught.code}`);
}

test('dispatch: missing file_path → MISSING_REQUIRED_ARG', async () => {
  await expectDispatchFails('xlsx_doctor', {}, 'MISSING_REQUIRED_ARG');
});

test('dispatch: empty-string file_path → MISSING_REQUIRED_ARG', async () => {
  await expectDispatchFails('xlsx_doctor', { file_path: '' }, 'MISSING_REQUIRED_ARG');
});

test('dispatch: base64-shaped file_path → BASE64_MISREAD', async () => {
  // Long base64-alphabet-only string. No slashes, no tilde, no drive letter.
  const base64Bytes = 'UEsDBBQAAAAIANq5p1q7N5e/' + 'A'.repeat(400);
  await expectDispatchFails('xlsx_read', { file_path: base64Bytes }, 'BASE64_MISREAD');
});

test('dispatch: base64 on xlsx_diff → flags the *_a / *_b path fields', async () => {
  const base64Bytes = 'UEsDBBQAAAAIANq5p1q7N5e/' + 'B'.repeat(400);
  await expectDispatchFails(
    'xlsx_diff',
    {
      file_path_a: '/Users/bob/a.xlsx',
      file_path_b: base64Bytes,
    },
    'BASE64_MISREAD'
  );
});

test('dispatch: a normal absolute path passes validation (no false-positive)', async () => {
  // Validation passes; dispatch proceeds to fileToB64 which then fails on
  // ENOENT — that's expected since the path doesn't exist. We just want to
  // confirm we got PAST validateToolArgs.
  let caught;
  try {
    await dispatchTool('xlsx_doctor', { file_path: '/nonexistent/path/to/workbook.xlsx' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'fileToB64 should fail on a nonexistent file');
  assert.notEqual(caught.code, 'BASE64_MISREAD');
  assert.notEqual(caught.code, 'MISSING_REQUIRED_ARG');
  // The error code should be FILE_NOT_FOUND from fileToB64.
  assert.equal(caught.code, 'FILE_NOT_FOUND');
});

test('dispatch: a tilde path passes validation (~ is path-shaped)', async () => {
  let caught;
  try {
    await dispatchTool('xlsx_doctor', { file_path: '~/Desktop/nonexistent.xlsx' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.notEqual(caught.code, 'BASE64_MISREAD');
});

test('dispatch: a short string with no slashes is NOT flagged (below length threshold)', async () => {
  // "foo.xlsx" is a relative path without slashes, but length 8 << 200 →
  // not a base64-shape match. Validation passes; FILE_NOT_FOUND fires from
  // fileToB64.
  let caught;
  try {
    await dispatchTool('xlsx_doctor', { file_path: 'foo.xlsx' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.notEqual(caught.code, 'BASE64_MISREAD');
  assert.equal(caught.code, 'FILE_NOT_FOUND');
});
