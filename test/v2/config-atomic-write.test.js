'use strict';

/**
 * A failed config write must not destroy the user's API key (XLS-511).
 *
 * writeConfig() used to open the real config.json, `ftruncateSync(fd, 0)` it, and only then
 * `writeSync` the new contents. The old value was destroyed while the new one existed only in
 * memory, with no temp file and no rename — so a write that failed in between left an EMPTY config
 * and an unrecoverable api_key.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. The trigger is ENOSPC, not a crash. The obvious framing is "kill -9 between two adjacent
 *    lines" — a microsecond window that reads as unlikely. The reachable one is a full disk:
 *    ftruncate FREES space and therefore SUCCEEDS, and the write that follows is exactly what runs
 *    out of it. No crash, no unusual timing. EDQUOT, EIO and a short write reach it the same way.
 *
 * 2. Every arm asserts the simulated failure ACTUALLY FIRED. If it does not, the key survives
 *    trivially and the test passes having exercised nothing — a green that means the opposite of
 *    what it appears to mean. `writesFailed` is what makes these assertions non-vacuous.
 *
 * 3. mergeConfig is the realistic caller and the worst case: it reads the whole config, merges a
 *    patch, and writes the UNION back. So a failed one-field update (`telemetry: false`) is what
 *    destroys every OTHER field, including a key nobody was touching.
 *
 * The permission properties these must not regress live in config-perms.test.js (XLS-408). A fix
 * that trades a data-loss bug for a key-disclosure bug is not a fix.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'secret-bearer-key-that-must-survive';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-atomic-'));
  return path.join(dir, '.xlsx-for-ai');
}

function load() {
  delete require.cache[require.resolve('../../lib/config')];
  return require('../../lib/config');
}

function withConfigDir(cfgDir, fn) {
  const prevEnv = process.env.XFA_CONFIG_DIR;
  process.env.XFA_CONFIG_DIR = cfgDir;
  try {
    return fn();
  } finally {
    if (prevEnv === undefined) delete process.env.XFA_CONFIG_DIR;
    else process.env.XFA_CONFIG_DIR = prevEnv;
  }
}

/**
 * Fail every write that lands inside `cfgDir` with ENOSPC, and count them.
 *
 * writeSync and writeFileSync are both intercepted so the arm is not pinned to one primitive: a
 * writer that switched must still be exercised rather than silently skipped into a pass.
 */
function withFailingWrites(cfgDir, fn) {
  const root = path.resolve(cfgDir);
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const realWriteFile = fs.writeFileSync;
  const ourFds = new Set();
  let writesFailed = 0;

  const inConfigDir = (p) => {
    try {
      return typeof p === 'string' && path.resolve(p).startsWith(root + path.sep);
    } catch (_) {
      return false;
    }
  };
  const enospc = () => {
    writesFailed++;
    const e = new Error('ENOSPC: no space left on device, write');
    e.code = 'ENOSPC';
    e.errno = -28;
    return e;
  };

  fs.openSync = function (p, ...rest) {
    const fd = realOpen.call(fs, p, ...rest);
    if (inConfigDir(p)) ourFds.add(fd);
    return fd;
  };
  fs.writeSync = function (fd, ...rest) {
    if (ourFds.has(fd)) throw enospc();
    return realWrite.call(fs, fd, ...rest);
  };
  fs.writeFileSync = function (target, ...rest) {
    if ((typeof target === 'number' && ourFds.has(target)) || inConfigDir(target)) throw enospc();
    return realWriteFile.call(fs, target, ...rest);
  };

  try {
    fn();
  } finally {
    fs.openSync = realOpen;
    fs.writeSync = realWrite;
    fs.writeFileSync = realWriteFile;
  }
  return writesFailed;
}

/**
 * Make writes to `cfgDir` return a SHORT COUNT instead of throwing: the first write puts down half
 * the bytes, and every write after it reports no progress at all.
 *
 * This is the nastier half of a full disk and the one an ENOSPC-throws stub never reaches. write(2)
 * on a filesystem with room for SOME of the data returns a short count and does NOT fail, so a
 * writer that trusts one unchecked writeSync believes it succeeded while holding a truncated file.
 * If that file is then renamed into place, the corruption is installed atomically over a good
 * config — this bug, one layer down.
 *
 * `stalls` also proves the writer's loop TERMINATES: a writer that spins on a zero-byte return
 * hangs here instead of failing, and the test times out rather than passing.
 */
function withShortWrites(cfgDir, fn) {
  const root = path.resolve(cfgDir);
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const ourFds = new Set();
  let calls = 0;

  fs.openSync = function (p, ...rest) {
    const fd = realOpen.call(fs, p, ...rest);
    try {
      if (typeof p === 'string' && path.resolve(p).startsWith(root + path.sep)) ourFds.add(fd);
    } catch (_) { /* not ours */ }
    return fd;
  };
  fs.writeSync = function (fd, data, ...rest) {
    if (!ourFds.has(fd)) return realWrite.call(fs, fd, data, ...rest);
    calls++;
    if (calls > 1) return 0; // the disk is now genuinely full: no progress, no error
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const off = Buffer.isBuffer(data) && typeof rest[0] === 'number' ? rest[0] : 0;
    const len = Buffer.isBuffer(data) && typeof rest[1] === 'number' ? rest[1] : buf.length - off;
    const half = Math.max(1, Math.floor(len / 2));
    return realWrite.call(fs, fd, buf, off, half); // half lands, and we honestly report half
  };

  try {
    fn();
  } finally {
    fs.openSync = realOpen;
    fs.writeSync = realWrite;
  }
  return calls;
}

const readRaw = (cfgDir) => fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');

test('a failed write leaves the existing api_key intact (ENOSPC on a full disk)', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig, readConfig } = load();
    writeConfig({ api_key: KEY, client_id: 'abc', telemetry: true });
    assert.equal(readConfig().api_key, KEY, 'precondition: the key is on disk to be threatened');

    let threw = null;
    const writesFailed = withFailingWrites(cfgDir, () => {
      try {
        mergeConfig({ telemetry: false });
      } catch (e) {
        threw = e;
      }
    });

    assert.ok(writesFailed > 0, 'the simulated ENOSPC must fire, or a surviving key proves nothing');
    assert.equal(threw && threw.code, 'ENOSPC', 'the failure must reach the caller, not be swallowed');
    assert.equal(readConfig().api_key, KEY, 'the api_key must survive a failed write — it is unrecoverable');
  });
});

test('a failed one-field update does not destroy the OTHER fields (mergeConfig writes the union)', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig, readConfig } = load();
    const original = { api_key: KEY, client_id: 'abc', registered_at: '2026-01-01T00:00:00.000Z', telemetry: true };
    writeConfig(original);

    const writesFailed = withFailingWrites(cfgDir, () => {
      try {
        mergeConfig({ telemetry: false });
      } catch (_) { /* the throw is asserted above; here the disk is the subject */ }
    });

    assert.ok(writesFailed > 0, 'non-vacuity: the write must have been exercised');
    assert.deepEqual(readConfig(), original, 'a failed telemetry toggle must not take the whole config with it');
  });
});

test('a failed write leaves the config parseable — never empty or truncated', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig } = load();
    writeConfig({ api_key: KEY, client_id: 'abc' });

    const writesFailed = withFailingWrites(cfgDir, () => {
      try {
        mergeConfig({ telemetry: false });
      } catch (_) { /* disk state is the subject */ }
    });

    assert.ok(writesFailed > 0, 'non-vacuity: the write must have been exercised');
    const raw = readRaw(cfgDir);
    assert.notEqual(raw.trim(), '', 'config.json must never be left zero-length');
    assert.doesNotThrow(() => JSON.parse(raw), 'a reader must never find a half-written config');
  });
});

test('a failed write leaves no key-bearing temp file behind', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig } = load();
    writeConfig({ api_key: KEY, client_id: 'abc' });

    const writesFailed = withFailingWrites(cfgDir, () => {
      try {
        mergeConfig({ telemetry: false });
      } catch (_) { /* the litter is the subject */ }
    });
    assert.ok(writesFailed > 0, 'non-vacuity: the write must have been exercised');

    const strays = fs.readdirSync(cfgDir).filter((f) => f !== 'config.json');
    assert.deepEqual(strays, [], `a failed write must not litter the config dir: ${strays.join(', ')}`);
  });
});

test('a SHORT write never installs a truncated config (write(2) returns a count, it does not throw)', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig, readConfig } = load();
    const original = { api_key: KEY, client_id: 'abc', registered_at: '2026-01-01T00:00:00.000Z', telemetry: true };
    writeConfig(original);

    let threw = null;
    const calls = withShortWrites(cfgDir, () => {
      try {
        mergeConfig({ telemetry: false });
      } catch (e) {
        threw = e;
      }
    });

    assert.ok(calls > 0, 'non-vacuity: the short write must have been exercised');
    assert.ok(threw, 'a config that could not be written in full must not be reported as written');
    assert.deepEqual(readConfig(), original, 'a half-written config must never replace the real one');
    const strays = fs.readdirSync(cfgDir).filter((f) => f !== 'config.json');
    assert.deepEqual(strays, [], `the truncated staging file must be cleaned up: ${strays.join(', ')}`);
  });
});

test('a successful write leaves no temp file behind', () => {
  const cfgDir = sandbox();
  withConfigDir(cfgDir, () => {
    const { writeConfig, mergeConfig, readConfig } = load();
    writeConfig({ api_key: KEY, client_id: 'abc' });
    mergeConfig({ telemetry: false });

    assert.equal(readConfig().api_key, KEY, 'the happy path must still work');
    assert.equal(readConfig().telemetry, false, 'the update must actually land');
    const strays = fs.readdirSync(cfgDir).filter((f) => f !== 'config.json');
    assert.deepEqual(strays, [], `the swap must clean up after itself: ${strays.join(', ')}`);
  });
});
