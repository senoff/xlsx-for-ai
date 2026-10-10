'use strict';

// Regression test for SPM P1 2026-06-06 "secondary" finding
// (xlsx-hosted-tool-latency-timeout, the small mechanics nicety).
//
// Models often pass paths with a leading `~/` ("~/Desktop/foo.xlsx").
// Node's fs APIs don't expand `~` — the path opens a literal file at
// `<cwd>/~/Desktop/foo.xlsx` and ENOENTs. We expand the leading `~` in the
// shared read helper so tilde paths just work for both entrypoints.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

// expandTilde now lives in — and is exported from — the shared hardened reader
// (XLS-815: lib/read-file.js is the single local-file read path for both the
// MCP server and the CLI). Pull it directly; no source-scrape needed.
const { expandTilde } = require('../../lib/read-file');

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
