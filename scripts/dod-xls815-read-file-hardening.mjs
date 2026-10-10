#!/usr/bin/env node
/**
 * XLS-815 DoD — one hardened file-read path for both entrypoints + L1 backstops.
 *
 * Register-before-land primary check. Runs from the npm-package repo root
 * (/Users/robertsenoff/xlsx-for-ai) against the LANDED tree. Asserts the DoD
 * clauses of the read-file hardening:
 *
 *   ARM 1  lib/read-file.js exists, exports readFileToBase64, and carries the
 *          load-bearing hardening: the size cap that raises FILE_TOO_LARGE and
 *          the O_NOFOLLOW symlink refusal.
 *   ARM 2  BOTH entrypoints route through it — index.js AND mcp.js each
 *          `require('./lib/read-file')`, and index.js no longer reads a workbook
 *          via `readFileSync(...).toString('base64')` (the CLI's single read
 *          path is the shared helper; the .json --checks read stays utf8 and is
 *          not a base64 workbook read, so it is not matched). Comments are
 *          stripped first so prose can't satisfy or trip the assertion.
 *   ARM 3  mcp.js installs the L1 process backstops — uncaughtException AND
 *          unhandledRejection handlers — inside the require.main===module guard.
 *   ARM 4  lib/read-file.js is in package.json `files` (a runtime-required lib
 *          file must ship, else MODULE_NOT_FOUND on install).
 *   ARM 5  The hardening test is green with a real (non-zero, floored) test
 *          count — proving the oversize→FILE_TOO_LARGE behavior via both
 *          entrypoints, not an emptied-file tautology.
 *
 * Exit contract: 0 = PASS, 1 = RED (a clause failed), 6 = INDETERMINATE (a
 * required source artifact is absent, or the test run could not complete —
 * never a false verdict).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const fails = [];

/** Read a required file or exit 6 (absent artifact != a RED verdict). */
function readOr6(path, why) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    console.error(`XLS-815 CHECK: INDETERMINATE -- ${why} (${path} absent). ` +
      `It lands with the npm-package PR; sync ~/xlsx-for-ai to a ref that contains it.`);
    process.exit(6);
  }
}

/** Strip block + line comments so prose can't satisfy or trip a source assertion. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// --- ARM 1: shared reader exists, exported, hardened ------------------------
const reader = stripComments(readOr6('lib/read-file.js', 'the shared hardened reader'));
if (!/\breadFileToBase64\b/.test(reader) || !/module\.exports\s*=/.test(reader)) {
  fails.push('ARM1: lib/read-file.js does not export readFileToBase64');
}
if (!/FILE_TOO_LARGE/.test(reader)) {
  fails.push('ARM1: lib/read-file.js is missing the FILE_TOO_LARGE size cap');
}
if (!/O_NOFOLLOW/.test(reader)) {
  fails.push('ARM1: lib/read-file.js is missing the O_NOFOLLOW symlink refusal');
}

// --- ARM 2: both entrypoints route through the shared reader ----------------
const REQUIRE_READFILE = /require\(\s*['"]\.\/lib\/read-file['"]\s*\)/;
const BASE64_READ = /readFileSync\([^)]*\)\s*\.\s*toString\(\s*['"]base64['"]\s*\)/;

const index = stripComments(readOr6('index.js', 'the CLI entrypoint'));
if (!REQUIRE_READFILE.test(index)) {
  fails.push('ARM2: index.js does not require ./lib/read-file');
}
if (BASE64_READ.test(index)) {
  fails.push('ARM2: index.js still reads a workbook via readFileSync(...).toString("base64") — not the single shared path');
}

const mcp = stripComments(readOr6('mcp.js', 'the MCP entrypoint'));
if (!REQUIRE_READFILE.test(mcp)) {
  fails.push('ARM2: mcp.js does not require ./lib/read-file');
}

// --- ARM 3: L1 process backstops in mcp.js ---------------------------------
if (!/process\.on\(\s*['"]uncaughtException['"]/.test(mcp)) {
  fails.push('ARM3: mcp.js is missing the uncaughtException backstop');
}
if (!/process\.on\(\s*['"]unhandledRejection['"]/.test(mcp)) {
  fails.push('ARM3: mcp.js is missing the unhandledRejection backstop');
}
if (!/require\.main\s*===\s*module/.test(mcp)) {
  fails.push('ARM3: mcp.js has no require.main===module entrypoint guard (backstops must not install on require)');
}

// --- ARM 4: shared reader is publishable -----------------------------------
let pkg;
try {
  pkg = JSON.parse(readOr6('package.json', 'the package manifest'));
} catch {
  fails.push('ARM4: package.json is not valid JSON');
  pkg = { files: [] };
}
if (!Array.isArray(pkg.files) || !pkg.files.includes('lib/read-file.js')) {
  fails.push('ARM4: lib/read-file.js is not in package.json `files` (would MODULE_NOT_FOUND on install)');
}

// --- ARM 5: the hardening test is green with a floored test count -----------
readOr6('test/v2/read-file-hardening.test.js', 'the read-file hardening DoD test');
let out;
try {
  out = execFileSync(
    process.execPath,
    ['--test', 'test/v2/read-file-hardening.test.js'],
    { encoding: 'utf8', timeout: 180_000 },
  );
} catch (err) {
  if (err && (err.killed || err.signal || err.code === 'ETIMEDOUT')) {
    console.error('XLS-815 CHECK: INDETERMINATE -- the hardening test run timed out or was killed (env fault, not a verdict).');
    process.exit(6);
  }
  // Non-zero exit = tests actually failed. Surface stdout so the failure is named.
  out = (err && (err.stdout || '')) + (err && (err.stderr || ''));
  const failed = /# fail (\d+)/.exec(out);
  fails.push(`ARM5: the hardening test did not pass${failed ? ` (# fail ${failed[1]})` : ''}`);
}
if (out) {
  // The PRIMARY green signal is the child exit code: execFileSync throws on any
  // non-zero exit, so reaching here means node:test exited 0 (all tests passed).
  // The count markers are a SECONDARY floor against an emptied-file tautology.
  // Only enforce that floor when the markers are actually present — if a
  // node:test reporter-format drift makes them unparseable, that is an env fault
  // (INDETERMINATE), never a false RED on a zero count.
  const hasMarkers = /# tests \d+/.test(out) && /# pass \d+/.test(out);
  if (hasMarkers) {
    const passN = Number((/# pass (\d+)/.exec(out) || [])[1] || 0);
    const failN = Number((/# fail (\d+)/.exec(out) || [])[1] || 0);
    const testsN = Number((/# tests (\d+)/.exec(out) || [])[1] || 0);
    if (failN > 0) fails.push(`ARM5: the hardening test reported ${failN} failure(s)`);
    if (testsN < 5) fails.push(`ARM5: expected >= 5 hardening tests, saw ${testsN} (emptied-file tautology guard)`);
    if (passN < 5) fails.push(`ARM5: expected >= 5 passing hardening tests, saw ${passN}`);
  } else {
    console.error('XLS-815 CHECK: INDETERMINATE -- node:test exited 0 but emitted no parseable count markers (reporter drift); cannot floor the test count.');
    process.exit(6);
  }
}

// --- verdict ---------------------------------------------------------------
if (fails.length) {
  console.error('XLS-815 CHECK: RED');
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('XLS-815 CHECK: PASS -- one hardened read path (lib/read-file.js) for both ' +
  'entrypoints; CLI reads route through it; mcp.js carries the L1 backstops; ' +
  'oversize -> clean FILE_TOO_LARGE proven via both entrypoints.');
process.exit(0);
