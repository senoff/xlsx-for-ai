'use strict';

// Regression test for SPM P1 2026-06-06 "secondary" finding
// (xlsx-hosted-tool-latency-timeout, the small mechanics nicety).
//
// Models often pass paths with a leading `~/` ("~/Desktop/foo.xlsx").
// Node's fs APIs don't expand `~` — the path opens a literal file at
// `<cwd>/~/Desktop/foo.xlsx` and ENOENTs. We expand the leading `~` in
// fileToB64 so tilde paths just work.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_PATH = path.join(__dirname, '..', '..', 'mcp.js');

// Pull the (unexported) expandTilde via require-cache + module re-eval. The
// mcp.js module side-effects on load are limited to defining TOOLS + helpers;
// we read the source and extract the function body.
function extractExpandTilde() {
  const src = fs.readFileSync(MCP_PATH, 'utf8');
  const match = src.match(/function expandTilde\([^)]*\)\s*\{[\s\S]*?^\}/m);
  assert.ok(match, 'expandTilde not found in mcp.js');
  // eslint-disable-next-line no-new-func
  return new Function('os', 'path', `${match[0]}; return expandTilde;`)(os, path);
}

const expandTilde = extractExpandTilde();

test('expandTilde: leaves non-tilde paths unchanged', () => {
  assert.equal(expandTilde('/Users/bob/Desktop/foo.xlsx'), '/Users/bob/Desktop/foo.xlsx');
  assert.equal(expandTilde('./relative/path.xlsx'), './relative/path.xlsx');
  assert.equal(expandTilde('plain.xlsx'), 'plain.xlsx');
});

test('expandTilde: replaces bare `~` with the home dir', () => {
  assert.equal(expandTilde('~'), os.homedir());
});

test('expandTilde: replaces leading `~/` with the home dir + path.join', () => {
  const expected = path.join(os.homedir(), 'Desktop', 'foo.xlsx');
  assert.equal(expandTilde('~/Desktop/foo.xlsx'), expected);
});

test('expandTilde: does NOT expand mid-string `~` (only the leading prefix)', () => {
  assert.equal(expandTilde('/Users/~/foo'), '/Users/~/foo');
  assert.equal(expandTilde('foo~bar'), 'foo~bar');
});

test('expandTilde: does NOT try to resolve `~user/` patterns (forward-only narrow)', () => {
  // We only handle `~` and `~/...`. `~someuser/...` passes through
  // untouched — it'd ENOENT just like before, but ~user-style paths are
  // rare and the safe path-resolution semantics aren't worth replicating
  // POSIX's getpwnam behavior for.
  assert.equal(expandTilde('~bob/Desktop/foo.xlsx'), '~bob/Desktop/foo.xlsx');
});

test('expandTilde: tolerates non-string + empty input', () => {
  assert.equal(expandTilde(''), '');
  assert.equal(expandTilde(null), null);
  assert.equal(expandTilde(undefined), undefined);
  assert.equal(expandTilde(123), 123);
});
