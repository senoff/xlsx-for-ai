'use strict';

// XLS-264: the post-registration orientation block. Pins (1) the exact copy,
// (2) that it prints on a FRESH MCP registration but stays quiet on a noop
// re-install, and (3) that bare `xfa` and `xfa --help` surface it and exit 0.
//
// The block is the one moment we have the user's terminal, so its bytes are a
// contract — a silent copy drift or a regression that stops it printing on
// fresh install is exactly what this suite catches before publish.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOOLS_URL,
  ORIENTATION_LINES,
  orientationText,
  printOrientation,
} = require('../../lib/orientation');

const INDEX = path.join(__dirname, '..', '..', 'index.js');
const BIN = '/usr/local/bin/xlsx-for-ai-mcp';
const FIRST_LINE = 'You can use xfa to access xlsx-for-ai.';

// ---- copy contract -------------------------------------------------------

test('orientation copy: four lines, exact wording, bare tools URL', () => {
  assert.equal(ORIENTATION_LINES.length, 4);
  assert.equal(ORIENTATION_LINES[0], FIRST_LINE);
  assert.equal(TOOLS_URL, 'xlsx-for-ai.dev/#tools');
  // The URL is shown BARE — no scheme.
  assert.ok(!orientationText().includes('https://'), 'tools URL must be shown without https://');
  assert.ok(orientationText().includes('xfa feedback "<your message>"'));
  assert.ok(orientationText().includes('xfa support "<your email>" "<your question>"'));
});

test('printOrientation writes the block to the injected writer', () => {
  let buf = '';
  printOrientation((m) => { buf += m; });
  for (const line of ORIENTATION_LINES) {
    assert.ok(buf.includes(line), `missing line: ${line}`);
  }
});

// ---- fresh-registration surface -----------------------------------------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-orient-'));
  return { cfg: path.join(dir, '.claude.json') };
}

function loadRegister() {
  delete require.cache[require.resolve('../../lib/mcp-register')];
  return require('../../lib/mcp-register');
}

function withEnv(cfg, fn) {
  const prevCfg = process.env.XFA_CLAUDE_CONFIG;
  const prevBin = process.env.XFA_GLOBAL_BIN;
  process.env.XFA_CLAUDE_CONFIG = cfg;
  process.env.XFA_GLOBAL_BIN = BIN;
  try { return fn(); }
  finally {
    if (prevCfg === undefined) delete process.env.XFA_CLAUDE_CONFIG; else process.env.XFA_CLAUDE_CONFIG = prevCfg;
    if (prevBin === undefined) delete process.env.XFA_GLOBAL_BIN; else process.env.XFA_GLOBAL_BIN = prevBin;
  }
}

test('fresh registration prints the orientation block', () => {
  const { cfg } = sandbox();
  const logs = [];
  withEnv(cfg, () => {
    const { registerMcpServer } = loadRegister();
    const res = registerMcpServer({ mode: 'postinstall', log: (m) => logs.push(m) });
    assert.equal(res.changed, true, 'net-new registration is a change');
  });
  assert.ok(logs.join('').includes(FIRST_LINE), 'orientation must print on fresh registration');
});

test('noop re-install stays quiet — no orientation block', () => {
  const { cfg } = sandbox();
  // Pre-seed a config already pointing at the current global bin, no legacy key.
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: { 'xfa': { type: 'stdio', command: BIN, args: [], env: {} } },
  }));
  const logs = [];
  withEnv(cfg, () => {
    const { registerMcpServer } = loadRegister();
    const res = registerMcpServer({ mode: 'postinstall', log: (m) => logs.push(m) });
    assert.equal(res.changed, false, 'already-current is a noop');
  });
  assert.ok(!logs.join('').includes(FIRST_LINE), 'a re-install must NOT re-print orientation');
});

// ---- CLI help surface (no live API needed — exits before registration) ---

function runCli(args) {
  const r = spawnSync('node', [INDEX, ...args], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('bare `xfa` prints usage + orientation and exits 0', () => {
  const { code, stdout } = runCli([]);
  assert.equal(code, 0, 'bare invocation exits 0');
  assert.ok(stdout.includes('Usage: xfa <file.xlsx>'), 'usage line uses the xfa program name');
  assert.ok(stdout.includes(FIRST_LINE), 'orientation block present on bare invocation');
});

test('`xfa --help` prints the orientation block and exits 0', () => {
  const { code, stdout } = runCli(['--help']);
  assert.equal(code, 0, '--help exits 0');
  assert.ok(stdout.includes(FIRST_LINE), 'orientation block present on --help');
});
