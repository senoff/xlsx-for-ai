'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function load() {
  delete require.cache[require.resolve('../../lib/installer-cleanup')];
  return require('../../lib/installer-cleanup');
}

function mkPkgDir(root, ...segs) {
  const p = path.join(root, ...segs, 'node_modules', 'xlsx-for-ai');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), '{"name":"xlsx-for-ai"}');
  return p;
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-clean-'));
}

const noLog = () => {};

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('dry-run lists npx caches but deletes nothing', () => {
  const dir = sandbox();
  const npx = path.join(dir, '_npx');
  const target = mkPkgDir(npx, 'abc123');
  withEnv({ XFA_NPX_CACHE_DIR: npx, XFA_PREFIX_CANDIDATES: '', XFA_CURRENT_GLOBAL: '' }, () => {
    const { runCleanup } = load();
    const res = runCleanup({ confirm: false, log: noLog });
    assert.deepEqual(res.wouldRemove, [target]);
    assert.deepEqual(res.removed, []);
    assert.ok(fs.existsSync(target), 'dry-run must not delete');
  });
});

test('--confirm deletes the npx cache and is idempotent', () => {
  const dir = sandbox();
  const npx = path.join(dir, '_npx');
  const target = mkPkgDir(npx, 'abc123');
  withEnv({ XFA_NPX_CACHE_DIR: npx, XFA_PREFIX_CANDIDATES: '', XFA_CURRENT_GLOBAL: '' }, () => {
    const { runCleanup } = load();
    const res = runCleanup({ confirm: true, log: noLog });
    assert.deepEqual(res.removed, [target]);
    assert.ok(!fs.existsSync(target));
    const res2 = runCleanup({ confirm: true, log: noLog });
    assert.deepEqual(res2.removed, []);
  });
});

test('HARD GUARD: never touches a sibling non-xlsx cache', () => {
  const dir = sandbox();
  const npx = path.join(dir, '_npx');
  const xfa = mkPkgDir(npx, 'h1');
  // A slack-mcp cache living right alongside it.
  const slack = path.join(npx, 'h2', 'node_modules', 'slack-mcp');
  fs.mkdirSync(slack, { recursive: true });
  fs.writeFileSync(path.join(slack, 'package.json'), '{"name":"slack-mcp"}');
  withEnv({ XFA_NPX_CACHE_DIR: npx, XFA_PREFIX_CANDIDATES: '', XFA_CURRENT_GLOBAL: '' }, () => {
    const { runCleanup } = load();
    runCleanup({ confirm: true, log: noLog });
    assert.ok(!fs.existsSync(xfa), 'xlsx-for-ai cache removed');
    assert.ok(fs.existsSync(slack), 'slack-mcp cache untouched');
  });
});

test('shadowing global at a non-current prefix is flagged; current is kept', () => {
  const dir = sandbox();
  const stalePrefix = path.join(dir, 'old-prefix');
  const currentPrefix = path.join(dir, 'cur-prefix');
  const stale = mkPkgDir(stalePrefix, 'lib');
  const current = mkPkgDir(currentPrefix, 'lib');
  withEnv({
    XFA_NPX_CACHE_DIR: path.join(dir, 'no-npx'),
    XFA_PREFIX_CANDIDATES: `${stalePrefix}:${currentPrefix}`,
    XFA_CURRENT_GLOBAL: current,
  }, () => {
    const { runCleanup } = load();
    const res = runCleanup({ confirm: false, log: noLog });
    assert.deepEqual(res.wouldRemove, [stale]);
    assert.ok(fs.existsSync(current), 'authoritative install never flagged');
  });
});

test('symlink to the current install is not flagged (realpath compare)', () => {
  const dir = sandbox();
  const currentPrefix = path.join(dir, 'cur-prefix');
  const current = mkPkgDir(currentPrefix, 'lib');
  // A second prefix whose package dir is a symlink to the current one.
  const linkPrefix = path.join(dir, 'link-prefix', 'lib', 'node_modules');
  fs.mkdirSync(linkPrefix, { recursive: true });
  const link = path.join(linkPrefix, 'xlsx-for-ai');
  fs.symlinkSync(current, link);
  withEnv({
    XFA_NPX_CACHE_DIR: path.join(dir, 'no-npx'),
    XFA_PREFIX_CANDIDATES: `${path.join(dir, 'link-prefix')}:${currentPrefix}`,
    XFA_CURRENT_GLOBAL: current,
  }, () => {
    const { runCleanup } = load();
    const res = runCleanup({ confirm: false, log: noLog });
    assert.deepEqual(res.wouldRemove, [], 'symlink to current must not be flagged');
  });
});

test('FAIL-SAFE: with no known current, a shadowing global is listed but never deleted', () => {
  const dir = sandbox();
  const prefix = path.join(dir, 'some-prefix');
  const shadow = mkPkgDir(prefix, 'lib');
  withEnv({
    XFA_NPX_CACHE_DIR: path.join(dir, 'no-npx'),
    XFA_PREFIX_CANDIDATES: prefix,
    XFA_CURRENT_GLOBAL: '', // defined-but-empty => current is unknowable
  }, () => {
    const { runCleanup } = load();
    const res = runCleanup({ confirm: true, log: noLog });
    assert.deepEqual(res.removed, [], 'must not delete when current is unknown');
    assert.deepEqual(res.wouldRemove, [shadow], 'still surfaced for the user');
    assert.ok(fs.existsSync(shadow), 'shadowing global untouched without a known current');
  });
});

test('isPackageDir enforces the node_modules/xlsx-for-ai shape', () => {
  const dir = sandbox();
  const { isPackageDir } = load();
  const good = mkPkgDir(dir, 'x');
  assert.equal(isPackageDir(good), true);
  const wrongName = path.join(dir, 'node_modules', 'other');
  fs.mkdirSync(wrongName, { recursive: true });
  assert.equal(isPackageDir(wrongName), false);
  const wrongParent = path.join(dir, 'not_node_modules', 'xlsx-for-ai');
  fs.mkdirSync(wrongParent, { recursive: true });
  assert.equal(isPackageDir(wrongParent), false);
});
