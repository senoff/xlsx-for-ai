'use strict';

/**
 * ~/.xlsx-for-ai/config.json holds `api_key` — the value lib/client.js sends as
 * `Authorization: Bearer`. It is a credential, and it must not be world-readable.
 *
 * lib/mcp-register.js already protects OTHER products' tokens this way (0600 file,
 * asserted in mcp-register.test.js). These are the equivalent assertions for OUR own
 * credential, which had none: writeConfig() passed no mode to mkdirSync/writeFileSync,
 * so on the default umask 0022 the file landed 0644.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. We force umask 0022. Without it, a tester running under a strict umask (0077)
 *    gets 0600 for free from the OS and the suite passes on code that has no mode at
 *    all — green on the one box where the bug cannot appear.
 *
 * 2. The `upgrade` arm matters more than the `create` arm. writeFileSync's `mode`
 *    option is honored ONLY on create; on an existing file it is silently ignored.
 *    Every user who registered before the fix already has a 0644 config.json, so a
 *    mode-only fix protects new installs and leaves the actual exposed population
 *    exposed. That arm is what forces the explicit chmod.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-cfg-'));
  return { home: dir, cfgDir: path.join(dir, '.xlsx-for-ai') };
}

// Fresh require so XFA_CONFIG_DIR is picked up per call (config.js reads it inside
// configDir(), but resetting keeps the tests hermetic against import order).
function load() {
  delete require.cache[require.resolve('../../lib/config')];
  return require('../../lib/config');
}

// The default umask on a normal user account. Pinned so the assertion is about our
// code's mode argument, not about the box the suite happens to run on.
function withDefaultUmask(cfgDir, fn) {
  const prevUmask = process.umask(0o022);
  const prevEnv = process.env.XFA_CONFIG_DIR;
  process.env.XFA_CONFIG_DIR = cfgDir;
  try {
    fn();
  } finally {
    if (prevEnv === undefined) delete process.env.XFA_CONFIG_DIR;
    else process.env.XFA_CONFIG_DIR = prevEnv;
    process.umask(prevUmask);
  }
}

const mode = (p) => fs.statSync(p).mode & 0o777;
const worldReadable = (p) => (fs.statSync(p).mode & 0o004) !== 0;
const groupReadable = (p) => (fs.statSync(p).mode & 0o040) !== 0;

// POSIX permission bits do not mean on Windows what they mean here, and writeConfig
// deliberately does not enforce them there. Asserting them anyway would be a red that
// says nothing about the code.
const posix = { skip: process.platform === 'win32' ? 'POSIX-only permission semantics' : false };

test('writeConfig creates config.json 0600 and its dir 0700 (it holds our Bearer api_key)', posix, () => {
  const { cfgDir } = sandbox();
  withDefaultUmask(cfgDir, () => {
    const { writeConfig, configPath } = load();
    writeConfig({ api_key: 'secret-bearer-key', client_id: 'abc' });

    const p = configPath();
    assert.equal(mode(p), 0o600, 'config.json holds the api_key and must be owner-only');
    assert.equal(worldReadable(p), false, 'config.json must not be world-readable');
    assert.equal(groupReadable(p), false, 'config.json must not be group-readable');
    assert.equal(mode(cfgDir), 0o700, 'the config dir must be owner-only');
  });
});

test('writeConfig TIGHTENS an already-0644 config.json (the pre-fix installed base)', posix, () => {
  // The population that is actually exposed: everyone who registered before the fix.
  // writeFileSync's `mode` is ignored on an existing file, so this arm fails against a
  // fix that only passes a mode and never chmods.
  const { cfgDir } = sandbox();
  withDefaultUmask(cfgDir, () => {
    const { writeConfig, configPath, mergeConfig } = load();
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(cfgDir, 0o755);
    const p = configPath();
    fs.writeFileSync(p, JSON.stringify({ api_key: 'old-key' }) + '\n', 'utf8');
    fs.chmodSync(p, 0o644); // exactly what the unfixed writeConfig left behind
    assert.equal(mode(p), 0o644, 'precondition: the file starts world-readable');

    writeConfig({ api_key: 'secret-bearer-key' });
    assert.equal(mode(p), 0o600, 'an upgrade must tighten the existing 0644 file, not preserve it');
    assert.equal(worldReadable(p), false);
    assert.equal(mode(cfgDir), 0o700, 'an existing 0755 dir must be tightened too');

    // mergeConfig is the path register/telemetry actually take to persist the key.
    fs.chmodSync(p, 0o644);
    mergeConfig({ registered_at: 'now' });
    assert.equal(mode(p), 0o600, 'mergeConfig must not leave the key world-readable either');
  });
});

test('repeated writes never widen perms', posix, () => {
  const { cfgDir } = sandbox();
  withDefaultUmask(cfgDir, () => {
    const { writeConfig, configPath } = load();
    writeConfig({ api_key: 'k1' });
    writeConfig({ api_key: 'k2' });
    writeConfig({ api_key: 'k3' });
    assert.equal(mode(configPath()), 0o600);
    assert.equal(mode(cfgDir), 0o700);
  });
});

test('writeConfig refuses to write the key THROUGH a planted symlink', posix, () => {
  // A chmod follows symlinks, so without O_NOFOLLOW a link planted at config.json would let
  // an attacker steer both the key and a 0600 chmod onto a file of their choosing (CWE-59).
  // The assertion that matters is not just "it threw" — it is that the target was never
  // touched, because a throw after the write would have leaked the key anyway.
  const { cfgDir } = sandbox();
  withDefaultUmask(cfgDir, () => {
    const { writeConfig, configPath } = load();
    const victim = path.join(cfgDir, '..', 'victim.txt');
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(victim, 'ORIGINAL CONTENT\n', 'utf8');
    fs.symlinkSync(victim, configPath());

    assert.throws(
      () => writeConfig({ api_key: 'secret-bearer-key' }),
      (e) => e.code === 'SYMLINK_REJECTED',
      'a symlink at config.json must be refused, not followed'
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL CONTENT\n', 'the link target must be untouched');
    assert.equal(fs.readFileSync(victim, 'utf8').includes('secret-bearer-key'), false, 'the key must not reach the target');
  });
});

test('a refused write leaves the existing config (and its key) intact', posix, () => {
  // writeConfig opens without O_TRUNC precisely so that a refusal cannot destroy the key it
  // declined to re-secure. Truncate-then-verify would wipe the user's credential on the way out.
  const { cfgDir } = sandbox();
  withDefaultUmask(cfgDir, () => {
    const { writeConfig, configPath } = load();
    writeConfig({ api_key: 'original-key' });
    const before = fs.readFileSync(configPath(), 'utf8');
    assert.equal(before.includes('original-key'), true);

    // Swap the file for a symlink, then attempt a write: it must be refused with the
    // original still readable at the real path.
    const real = path.join(cfgDir, 'real-config.json');
    fs.renameSync(configPath(), real);
    fs.symlinkSync(real, configPath());
    assert.throws(() => writeConfig({ api_key: 'new-key' }), (e) => e.code === 'SYMLINK_REJECTED');
    assert.equal(fs.readFileSync(real, 'utf8'), before, 'the refused write must not have truncated the config');
  });
});
