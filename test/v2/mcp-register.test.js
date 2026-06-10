'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = '/usr/local/bin/xlsx-for-ai-mcp';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-reg-'));
  const cfg = path.join(dir, '.claude.json');
  return { dir, cfg };
}

// Fresh require so env overrides are read at call time (they are read per-call,
// but resetting keeps tests hermetic).
function load() {
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

const noLog = () => {};

test('net-new: creates ~/.claude.json with minimal stdio entry', () => {
  const { cfg } = sandbox();
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.deepEqual(obj.mcpServers['xfa'], { type: 'stdio', command: BIN, args: [], env: {} });
  });
});

test('preserves other servers and other top-level keys', () => {
  const { cfg } = sandbox();
  fs.writeFileSync(cfg, JSON.stringify({
    someTopLevel: 'keep-me',
    mcpServers: {
      'slack-mcp': { type: 'stdio', command: '/opt/slack', env: { TOKEN: 'secret' } },
    },
  }));
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    registerMcpServer({ mode: 'cli', log: noLog });
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(obj.someTopLevel, 'keep-me');
    assert.deepEqual(obj.mcpServers['slack-mcp'], { type: 'stdio', command: '/opt/slack', env: { TOKEN: 'secret' } });
    assert.equal(obj.mcpServers['xfa'].command, BIN);
  });
});

test('repoints a stale xfa npx entry to the global bin', () => {
  const { cfg } = sandbox();
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      'xfa': { type: 'stdio', command: 'npx', args: ['-y', 'xlsx-for-ai-mcp'] },
    },
  }));
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(res.changed, true);
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.deepEqual(obj.mcpServers['xfa'], { type: 'stdio', command: BIN, args: [], env: {} });
  });
});

test('dupe migration: registering xfa removes the legacy xlsx-for-ai key', () => {
  const { cfg } = sandbox();
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      'slack-mcp': { command: '/opt/slack' },
      'xlsx-for-ai': { type: 'stdio', command: 'npx', args: ['-y', 'xlsx-for-ai-mcp'] },
    },
  }));
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(res.changed, true);
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(obj.mcpServers['xlsx-for-ai'], undefined, 'legacy key must be gone');
    assert.deepEqual(obj.mcpServers['xfa'], { type: 'stdio', command: BIN, args: [], env: {} });
    assert.deepEqual(obj.mcpServers['slack-mcp'], { command: '/opt/slack' });
  });
});

test('dupe migration fires even when xfa is already current', () => {
  const { cfg } = sandbox();
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      'xfa': { type: 'stdio', command: BIN, args: [], env: {} },
      'xlsx-for-ai': { type: 'stdio', command: BIN },
    },
  }));
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(res.changed, true, 'removing the legacy dupe is a change');
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(obj.mcpServers['xlsx-for-ai'], undefined, 'legacy key must be gone');
    assert.deepEqual(obj.mcpServers['xfa'], { type: 'stdio', command: BIN, args: [], env: {} });
  });
});

test('idempotent: a second register is a no-op', () => {
  const { cfg } = sandbox();
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    registerMcpServer({ mode: 'cli', log: noLog });
    const after1 = fs.readFileSync(cfg, 'utf8');
    const res = registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(res.changed, false);
    assert.equal(fs.readFileSync(cfg, 'utf8'), after1);
  });
});

test('invalid JSON: backs up and skips without throwing', () => {
  const { dir, cfg } = sandbox();
  fs.writeFileSync(cfg, '{ this is not json');
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'postinstall', log: noLog });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
    assert.ok(baks.length >= 1, 'expected a backup of the corrupt file');
  });
});

test('valid JSON but non-object shape: backs up and skips without throwing', () => {
  const { dir, cfg } = sandbox();
  fs.writeFileSync(cfg, '["not", "an", "object"]'); // valid JSON, wrong shape
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    const res = registerMcpServer({ mode: 'postinstall', log: noLog });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
    assert.ok(baks.length >= 1, 'expected a backup of the non-object config');
  });
});

test('missing global bin: cli mode throws, postinstall mode skips', () => {
  const { cfg } = sandbox();
  const prevCfg = process.env.XFA_CLAUDE_CONFIG;
  const prevBin = process.env.XFA_GLOBAL_BIN;
  process.env.XFA_CLAUDE_CONFIG = cfg;
  process.env.XFA_GLOBAL_BIN = ''; // empty -> resolveGlobalBin falls back to PATH lookup
  // Force a guaranteed miss by pointing at a name that won't resolve.
  process.env.XFA_GLOBAL_BIN = path.join(os.tmpdir(), 'definitely-not-on-path-xfa');
  try {
    // With an explicit (fake but truthy) bin, registration succeeds; to test
    // the miss path we must clear the override entirely and rely on PATH.
    delete process.env.XFA_GLOBAL_BIN;
    const { registerMcpServer } = load();
    // Ensure xlsx-for-ai-mcp is not actually on PATH in this hermetic run.
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-dir';
    try {
      assert.throws(() => registerMcpServer({ mode: 'cli', log: noLog }), /global xlsx-for-ai-mcp bin/);
      const res = registerMcpServer({ mode: 'postinstall', log: noLog });
      assert.equal(res.skipped, true);
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    if (prevCfg === undefined) delete process.env.XFA_CLAUDE_CONFIG; else process.env.XFA_CLAUDE_CONFIG = prevCfg;
    if (prevBin === undefined) delete process.env.XFA_GLOBAL_BIN; else process.env.XFA_GLOBAL_BIN = prevBin;
  }
});

test('uninstall removes the xfa entry (and any legacy key) and is idempotent', () => {
  const { cfg } = sandbox();
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      'slack-mcp': { command: '/opt/slack' },
      'xfa': { type: 'stdio', command: BIN },
      'xlsx-for-ai': { type: 'stdio', command: BIN },
    },
  }));
  withEnv(cfg, () => {
    const { unregisterMcpServer } = load();
    const r1 = unregisterMcpServer({ log: noLog });
    assert.equal(r1.changed, true);
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.ok(!obj.mcpServers['xfa']);
    assert.ok(!obj.mcpServers['xlsx-for-ai']);
    assert.deepEqual(obj.mcpServers['slack-mcp'], { command: '/opt/slack' });
    const r2 = unregisterMcpServer({ log: noLog });
    assert.equal(r2.changed, false);
  });
});

test('never widens ~/.claude.json perms (0600 on create, preserved on update)', () => {
  const { cfg } = sandbox();
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    // Create.
    registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    // Tighten further, then update via a stale->repoint and confirm not widened.
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'xfa': { command: 'npx' } } }), { mode: 0o600 });
    fs.chmodSync(cfg, 0o600);
    registerMcpServer({ mode: 'cli', log: noLog });
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  });
});

test('backup file does not widen perms beyond the source (~/.claude.json holds tokens)', () => {
  const { cfg, dir } = sandbox();
  withEnv(cfg, () => {
    const { registerMcpServer } = load();
    // Seed a stale entry at 0o600 so the next register backs it up before mutating.
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'xfa': { command: 'npx' } } }));
    fs.chmodSync(cfg, 0o600);
    registerMcpServer({ mode: 'cli', log: noLog });
    const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
    assert.equal(baks.length >= 1, true, 'expected a backup to be written');
    for (const b of baks) {
      assert.equal(fs.statSync(path.join(dir, b)).mode & 0o777, 0o600, `backup ${b} must not widen perms`);
    }
  });
});

test('isStaleEntry flags npx and non-bin commands, accepts the global bin', () => {
  const { isStaleEntry } = load();
  assert.equal(isStaleEntry({ command: 'npx', args: ['-y', 'xlsx-for-ai-mcp'] }, BIN), true);
  assert.equal(isStaleEntry({ command: '/old/path/xlsx-for-ai-mcp' }, BIN), true);
  assert.equal(isStaleEntry(null, BIN), true);
  assert.equal(isStaleEntry({ command: BIN, args: [] }, BIN), false);
});
