'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function load() {
  delete require.cache[require.resolve('../../lib/auto-upgrade')];
  return require('../../lib/auto-upgrade');
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-upg-'));
}

const noLog = () => {};

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('isNewer: ordinary version bumps', () => {
  const { isNewer } = load();
  assert.equal(isNewer('3.2.0', '3.1.0'), true);
  assert.equal(isNewer('3.1.1', '3.1.0'), true);
  assert.equal(isNewer('4.0.0', '3.9.9'), true);
  assert.equal(isNewer('3.1.0', '3.1.0'), false);
  assert.equal(isNewer('3.0.0', '3.1.0'), false);
});

test('isNewer: a prerelease of the same core is NOT newer (spec-gate C4)', () => {
  const { isNewer } = load();
  assert.equal(isNewer('1.0.0-beta', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0-beta'), true);   // release > its prerelease
  assert.equal(isNewer('1.0.0-rc.2', '1.0.0-rc.1'), true);
  assert.equal(isNewer('1.0.0-alpha', '1.0.0-beta'), false);
});

test('isNewer: build metadata is ignored (spec-gate C4)', () => {
  const { isNewer } = load();
  assert.equal(isNewer('1.0.0+build.1', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0+build.9'), false);
  assert.equal(isNewer('1.0.1+x', '1.0.0+y'), true);
});

test('isNewer: fail-safe false on unparseable input', () => {
  const { isNewer } = load();
  assert.equal(isNewer('garbage', '3.1.0'), false);
  assert.equal(isNewer('3.1.0', 'not-a-version'), false);
  assert.equal(isNewer('', '3.1.0'), false);
  assert.equal(isNewer('3.1', '3.0.0'), false); // not full semver-core
  assert.equal(isNewer(undefined, '3.1.0'), false);
});

test('checkForUpgrade: opt-out short-circuits before any network', async () => {
  const dir = sandbox();
  await withEnv({ XFA_CONFIG_DIR: dir, XFA_NO_AUTO_UPDATE: '1', XFA_LATEST_VERSION: '9.9.9' }, async () => {
    const { checkForUpgrade } = load();
    const res = await checkForUpgrade({ currentVersion: '3.1.0', log: noLog });
    assert.deepEqual(res, { skipped: 'opt-out' });
    assert.ok(!fs.existsSync(path.join(dir, 'upgrade-check.json')), 'no cache written when opted out');
  });
});

test('checkForUpgrade: throttled to once per 24h', async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'upgrade-check.json'), JSON.stringify({ lastCheck: Date.now() }));
  await withEnv({ XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '9.9.9', CI: '' }, async () => {
    const { checkForUpgrade } = load();
    const res = await checkForUpgrade({ currentVersion: '3.1.0', log: noLog });
    assert.deepEqual(res, { skipped: 'throttled' });
  });
});

test('checkForUpgrade: up-to-date records the check, takes no action', async () => {
  const dir = sandbox();
  await withEnv({ XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '3.1.0', CI: '' }, async () => {
    const { checkForUpgrade } = load();
    const res = await checkForUpgrade({ currentVersion: '3.1.0', log: noLog });
    assert.equal(res.upToDate, true);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'upgrade-check.json'), 'utf8'));
    assert.ok(cache.lastCheck > 0, 'throttle timestamp recorded');
  });
});

test('checkForUpgrade: newer version on a NON-writable root only hints, never upgrades', async () => {
  const dir = sandbox();
  // A path that doesn't exist is definitively non-writable (accessSync throws),
  // which is deterministic across platforms unlike chmod-as-owner.
  const root = path.join(sandbox(), 'does-not-exist');
  await withEnv({
    XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '99.0.0', CI: '',
    XFA_INSTALL_ROOT: root, XFA_UPGRADE_NOEXEC: '1',
  }, async () => {
    const { checkForUpgrade } = load();
    const res = await checkForUpgrade({ currentVersion: '3.1.0', log: noLog });
    assert.equal(res.hint, true, 'non-writable root takes the hint path');
    assert.equal(res.latest, '99.0.0');
  });
});

test('checkForUpgrade: newer version on a writable root kicks off an in-place upgrade', async () => {
  const dir = sandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-rw-'));
  await withEnv({
    XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '99.0.0', CI: '',
    XFA_INSTALL_ROOT: root, XFA_UPGRADE_NOEXEC: '1', // decide, don't actually npm i -g
  }, async () => {
    const { checkForUpgrade } = load();
    const res = await checkForUpgrade({ currentVersion: '3.1.0', log: noLog });
    assert.equal(res.upgrading, true, 'writable root takes the in-place upgrade path');
    assert.equal(res.latest, '99.0.0');
  });
});

test('fetchLatestVersion: honors the XFA_LATEST_VERSION test override', async () => {
  await withEnv({ XFA_LATEST_VERSION: '7.7.7' }, async () => {
    const { fetchLatestVersion } = load();
    assert.equal(await fetchLatestVersion(), '7.7.7');
  });
});
