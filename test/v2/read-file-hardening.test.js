'use strict';

// DoD test for XLS-815 — the shared hardened reader (lib/read-file.js) is the
// SINGLE local-file read path for both entrypoints, and an oversize file now
// returns a clean FILE_TOO_LARGE instead of OOM-ing into a generic
// "request failed".
//
// Coverage:
//   1. Unit — readFileToBase64 throws FILE_TOO_LARGE on an over-cap file
//      (the size check fires BEFORE the buffer is allocated: this IS the
//      not-OOM proof) and round-trips a small file with no false positive.
//   2. MCP entrypoint — dispatchTool('xlsx_doctor', {file_path}) surfaces the
//      SAME FILE_TOO_LARGE code (real dispatch → fileToB64 → readFileToBase64).
//   3. CLI entrypoint — a spawned `index.js <bigfile>` exits non-zero with the
//      friendly cap message on stderr. The cap fires client-side before any API
//      call, so this runs even under CI (registration is skipped).
//   4. L1 guard — requiring mcp.js installs NO process-level handlers (they
//      live only in the require.main===module entrypoint branch), so the
//      backstops can never pollute a test runner.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A 1 MB cap for the whole file: getMaxFileMB() reads this at call time, so an
// oversize fixture only needs to be > 1 MB. node --test isolates each test file
// in its own process, so this env set is local to this file.
process.env.XFA_MAX_FILE_MB = '1';

const { readFileToBase64 } = require('../../lib/read-file');

const INDEX = path.join(__dirname, '..', '..', 'index.js');

let tmpDir;
let bigFile;    // > 1 MB, allowed extension → trips the cap
let smallFile;  // tiny, allowed extension → reads fine

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls815-'));
  bigFile = path.join(tmpDir, 'oversize.xlsx');
  // 2 MB of filler. Contents are irrelevant — the cap is checked from fstat
  // size before any parse, so this never needs to be a real workbook.
  fs.writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024, 0x41));
  smallFile = path.join(tmpDir, 'ok.xlsx');
  fs.writeFileSync(smallFile, Buffer.from('hello-xls815'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// --- 1. unit ---------------------------------------------------------------

test('readFileToBase64: over-cap file throws FILE_TOO_LARGE (not OOM)', () => {
  let caught;
  try {
    readFileToBase64(bigFile);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected an over-cap read to throw');
  assert.equal(caught.code, 'FILE_TOO_LARGE', `wrong code: ${caught.code}`);
  assert.match(caught.message, /exceeds the 1 MB cap/);
});

test('readFileToBase64: a small allowed file round-trips with no false positive', () => {
  const b64 = readFileToBase64(smallFile);
  assert.equal(typeof b64, 'string');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'hello-xls815');
});

test('readFileToBase64: an allowed-extension symlink is refused (allowlist bypass closed)', () => {
  // A symlink named with an allowed extension pointing at any target must be
  // rejected via the explicit lstat check — on EVERY platform, not only where
  // O_NOFOLLOW is defined. This is the HIGH finding's regression guard.
  const evil = path.join(tmpDir, 'evil.xlsx');
  try {
    fs.symlinkSync(smallFile, evil);
  } catch (err) {
    // Symlink creation can be unavailable (e.g. unprivileged Windows). Skip
    // rather than false-fail — the guard itself is still compiled in.
    if (err && (err.code === 'EPERM' || err.code === 'ENOSYS')) return;
    throw err;
  }
  let caught;
  try {
    readFileToBase64(evil);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected a symlink read to throw');
  assert.equal(caught.code, 'SYMLINK_REJECTED', `wrong code: ${caught.code}`);
});

// --- 2. MCP entrypoint -----------------------------------------------------

test('MCP entrypoint: dispatchTool surfaces FILE_TOO_LARGE for an over-cap file', async () => {
  const { dispatchTool } = require('../../mcp.js');
  let caught;
  try {
    await dispatchTool('xlsx_doctor', { file_path: bigFile });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected dispatchTool to throw on an over-cap file');
  assert.equal(caught.code, 'FILE_TOO_LARGE', `wrong code: ${caught.code}`);
});

// --- 3. CLI entrypoint -----------------------------------------------------

test('CLI entrypoint: `xlsx-for-ai <oversize>` exits non-zero with the cap message', () => {
  const res = spawnSync(process.execPath, [INDEX, bigFile], {
    encoding: 'utf8',
    // XLSX_FOR_AI_CI=1 skips network registration so only the client-side cap
    // runs; XFA_MAX_FILE_MB=1 makes the 2 MB fixture over-cap for the child.
    env: { ...process.env, XLSX_FOR_AI_CI: '1', XFA_MAX_FILE_MB: '1' },
  });
  assert.notEqual(res.status, 0, `expected non-zero exit; got ${res.status}. stderr: ${res.stderr}`);
  assert.match(
    res.stderr,
    /exceeds the XFA_MAX_FILE_MB cap/,
    `expected the friendly FILE_TOO_LARGE message; got stderr: ${res.stderr}`,
  );
});

// --- 4. L1 guard -----------------------------------------------------------

test('L1: requiring mcp.js installs no process-level handlers', () => {
  const before = process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
  require('../../mcp.js');
  const afterCount = process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
  assert.equal(afterCount, before, 'requiring mcp.js must not register global exception handlers');
});
