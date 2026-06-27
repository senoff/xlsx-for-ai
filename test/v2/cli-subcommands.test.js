'use strict';

// Real-CLI assertions for the documented `xfa` subcommands (board cards
// XLS-6..XLS-10). These spawn the actual `index.js` binary against a bundled
// sample workbook and assert observable behaviour — exit code + stdout shape —
// so a Done card claiming "CLI read/clean/integrity/heal works" is backed by a
// command that genuinely fails if the mode breaks (not an inventory tautology).
//
// Every mode except `--version` round-trips through the live xfa API
// (ensureRegistered -> callTool), so those tests are integration-grade: the
// board-verify registry marks XLS-6/7/8/9 `heavy` (CI cadence), XLS-10 light.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const INDEX = path.join(__dirname, '..', '..', 'index.js');
const SAMPLE = path.join(__dirname, '..', '..', 'samples', 'reporting-pack-v1.xlsx');

function runCli(args, env = {}) {
  const r = spawnSync('node', [INDEX, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('cli version: --version prints a semver and exits 0', () => {
  const { code, stdout } = runCli(['--version']);
  assert.equal(code, 0, 'exit 0 expected');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, `expected semver; got ${stdout.trim()}`);
});

test('cli read md: default mode emits a Markdown table for the sample', () => {
  const { code, stdout } = runCli([SAMPLE]);
  assert.equal(code, 0, 'exit 0 expected');
  assert.match(stdout, /\| Date \|/, 'expected a Markdown table header');
});

test('cli read json: --json emits per-sheet JSON objects (sheet + rows keys)', () => {
  // --json interleaves `## SheetName` headers with one JSON object per sheet,
  // so it is not whole-stdout-parseable. Extract the first balanced {...} block
  // and JSON.parse it for real — a non-JSON body would throw here.
  const { code, stdout } = runCli([SAMPLE, '--json']);
  assert.equal(code, 0, 'exit 0 expected');
  const start = stdout.indexOf('{');
  assert.ok(start >= 0, 'expected at least one JSON object in output');
  let depth = 0, end = -1;
  for (let i = start; i < stdout.length; i++) {
    if (stdout[i] === '{') depth++;
    else if (stdout[i] === '}' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > start, 'expected a balanced JSON object');
  const obj = JSON.parse(stdout.slice(start, end + 1));
  assert.equal(typeof obj.sheet, 'string', 'parsed object should have a string "sheet"');
  assert.ok(Array.isArray(obj.rows), 'parsed object should have a "rows" array');
});

test('cli read sheet: --sheet scopes output to the named sheet only', () => {
  // Discriminating: scoping to Employees must emit that sheet's unique header
  // AND must NOT emit the Transactions sheet's header. A no-op --sheet that
  // dumped every sheet would fail the second assertion.
  const { code, stdout } = runCli([SAMPLE, '--sheet', 'Employees']);
  assert.equal(code, 0, 'exit 0 expected');
  assert.match(stdout, /\| EmployeeID \| FullName \|/, 'expected the Employees sheet header');
  assert.doesNotMatch(stdout, /\| Date \| Entity \| Department \|/, 'must not leak the Transactions sheet');
});

test('cli clean: --clean --execute writes a cleaned workbook to XFA_CLEAN_OUT', () => {
  const out = path.join(os.tmpdir(), `xfa-clean-${process.pid}-${Date.now()}.xlsx`);
  try {
    const { code } = runCli([SAMPLE, '--clean', '--execute'], { XFA_CLEAN_OUT: out });
    assert.equal(code, 0, 'exit 0 expected');
    assert.ok(fs.existsSync(out), 'expected a cleaned output file at XFA_CLEAN_OUT');
    assert.ok(fs.statSync(out).size > 0, 'cleaned file should be non-empty');
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('cli stamp: verify-stamp REJECTS an unstamped workbook (exit 1, not a blanket pass)', () => {
  // Discriminating negative: an unstamped file must fail verification. If
  // verify-stamp ever blanket-passed, this assertion would catch it.
  const { code, stdout } = runCli(['verify-stamp', SAMPLE]);
  assert.equal(code, 1, 'unstamped file must fail verification with exit 1');
  assert.match(stdout, /"valid"\s*:\s*false/, 'expected valid:false in the verdict');
});

test('cli heal: heal diagnoses the sample and exits 0', () => {
  const { code, stdout, stderr } = runCli(['heal', SAMPLE]);
  assert.equal(code, 0, 'exit 0 expected');
  // Assert the real diagnosis signature, not just non-empty output: the healer
  // reports a scan summary and a verdict. Help text or noise would not match.
  assert.match(stdout + stderr, /diagnose complete[\s\S]*Verdict:/i, 'expected a healer diagnosis summary + verdict');
});
