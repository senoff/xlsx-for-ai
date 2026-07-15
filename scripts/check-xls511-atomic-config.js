#!/usr/bin/env node
'use strict';

/**
 * XLS-511 — a failed config write must not destroy the user's API key.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS NOT A GREP
 * -------------------------------------------
 * The defect is that writeConfig() destroyed the old config before the new one existed
 * (`ftruncateSync(fd, 0)` then `writeSync`). Grepping for `ftruncateSync` would assert the
 * ABSENCE OF A STRING, which any refactor renames out from under us and which says nothing about
 * whether the key actually survives. So this drives the real function, makes the write FAIL the
 * way it fails in the wild (ENOSPC), and reads the key back OFF DISK.
 *
 * WHICH BYTES IT MEASURES — the published ones, not main
 * -----------------------------------------------------
 * The defect is live on what users install. Fixing main does not un-ship 3.2.4, so by default this
 * runs `npm pack xlsx-for-ai@latest` and measures THE PUBLISHED TARBALL. This check is therefore
 * expected to be RED until a fixed version is PUBLISHED — that is the honest state of the card, and
 * a green earned against a local build would be a lie about the surface users touch.
 * Use --module <path> to drive a local build (that is a dev/PR proof, NOT the card's verdict).
 *
 * THE ARMS
 * --------
 *   ARM 1  the property, vs the subject under test  -> key MUST survive a failed write
 *   ARM 2  the RED arm, pinned to 3.2.4             -> key MUST be destroyed (witnessed)
 *   ARM 3  the permission property, vs the subject  -> 0600 survives, symlink still refused
 *
 * ARM 2 is what makes ARM 1 mean anything. A green whose red arm was never seen fire proves
 * nothing, so if 3.2.4 does NOT lose the key, this check refuses to render a verdict at all
 * (INDETERMINATE) rather than report a green it cannot discriminate.
 *
 * NON-VACUITY
 * -----------
 * If the simulated failure never fires, the config survives TRIVIALLY and ARM 1 would pass having
 * tested nothing — a false green inside the false-green detector. Every arm therefore asserts the
 * stub was actually reached, and an arm that did not exercise a write is a FAIL, never a pass.
 *
 * EXIT CONTRACT (the fleet's shared word for a card check)
 *   0  GREEN          the key survives a failed write on the measured surface
 *   1  RED            the key is destroyed — the defect is live on what was measured
 *   7  INDETERMINATE  could not measure (npm unreachable, tarball unusable, red arm mute)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GREEN = 0;
const RED = 1;
const INDETERMINATE = 7;

// The version the defect is LIVE on. Pinned on purpose: this is the red arm's subject, and it must
// keep failing forever. If it is ever unpublished, that is INDETERMINATE, not a green.
const RED_ARM_VERSION = '3.2.4';

const ORIGINAL_KEY = 'xfa_live_key_do_not_lose_me_511';

function log(msg) {
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// fetching the bytes under test
// ---------------------------------------------------------------------------

function packAndExtract(spec, into) {
  fs.mkdirSync(into, { recursive: true });
  let out;
  try {
    out = execFileSync('npm', ['pack', spec, '--pack-destination', into, '--loglevel', 'error'], {
      cwd: into,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Network, 404, registry auth, timeout — we could not SEE the bytes. Not a verdict.
    throw Object.assign(new Error(`npm pack ${spec} failed: ${(e.stderr || e.message || '').toString().trim()}`), {
      indeterminate: true,
    });
  }
  const tgz = out.trim().split('\n').filter(Boolean).pop();
  if (!tgz) throw Object.assign(new Error(`npm pack ${spec} named no tarball`), { indeterminate: true });
  const tarball = path.isAbsolute(tgz) ? tgz : path.join(into, tgz);
  try {
    execFileSync('tar', ['xzf', tarball, '-C', into], { timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw Object.assign(new Error(`tar xzf ${tarball} failed: ${e.message}`), { indeterminate: true });
  }
  const mod = path.join(into, 'package', 'lib', 'config.js');
  if (!fs.existsSync(mod)) {
    throw Object.assign(new Error(`${spec}: no lib/config.js in the tarball`), { indeterminate: true });
  }
  let version = '(unknown)';
  try {
    version = JSON.parse(fs.readFileSync(path.join(into, 'package', 'package.json'), 'utf8')).version;
  } catch (_) { /* the module is what matters; the label is cosmetic */ }
  return { modPath: mod, version };
}

function loadFresh(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

// ---------------------------------------------------------------------------
// the simulated failure
// ---------------------------------------------------------------------------

/**
 * Make any write that lands inside the config dir fail with ENOSPC, and COUNT it.
 *
 * ENOSPC is the reachable trigger, not a contrived one: `ftruncateSync` FREES space and so
 * succeeds on a full disk, and the `writeSync` that follows is exactly what runs out of it. No
 * crash, no kill -9, no unusual timing.
 *
 * Both writeSync and writeFileSync are intercepted so the arm is not pinned to one implementation:
 * a fix that switched primitives must still be exercised, not silently skipped into a green.
 */
function armWriteFailure(cfgDir) {
  const root = path.resolve(cfgDir);
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const realWriteFile = fs.writeFileSync;
  const ourFds = new Set();
  let fired = 0;

  const inConfigDir = (p) => {
    try {
      return typeof p === 'string' && path.resolve(p).startsWith(root + path.sep);
    } catch (_) {
      return false;
    }
  };
  const enospc = (what) => {
    fired++;
    const e = new Error(`ENOSPC: no space left on device, ${what}`);
    e.code = 'ENOSPC';
    e.errno = -28;
    e.syscall = 'write';
    return e;
  };

  fs.openSync = function (p, ...rest) {
    const fd = realOpen.call(fs, p, ...rest);
    if (inConfigDir(p)) ourFds.add(fd);
    return fd;
  };
  fs.writeSync = function (fd, ...rest) {
    if (ourFds.has(fd)) throw enospc('write');
    return realWrite.call(fs, fd, ...rest);
  };
  fs.writeFileSync = function (target, ...rest) {
    if ((typeof target === 'number' && ourFds.has(target)) || inConfigDir(target)) throw enospc('writeFile');
    return realWriteFile.call(fs, target, ...rest);
  };

  return {
    get fired() { return fired; },
    restore() {
      fs.openSync = realOpen;
      fs.writeSync = realWrite;
      fs.writeFileSync = realWriteFile;
    },
  };
}

// ---------------------------------------------------------------------------
// reading the verdict off disk
// ---------------------------------------------------------------------------

function keyOnDisk(cfgDir) {
  const p = path.join(cfgDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { state: 'MISSING', detail: `config.json is gone (${e.code})` };
  }
  if (raw.trim() === '') return { state: 'EMPTY', detail: 'config.json is a zero-length file' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { state: 'CORRUPT', detail: `config.json is not parseable JSON (${raw.length} bytes)` };
  }
  if (parsed.api_key !== ORIGINAL_KEY) {
    return { state: 'KEY_GONE', detail: `api_key is ${JSON.stringify(parsed.api_key)}` };
  }
  return { state: 'INTACT', detail: 'api_key survived, byte-identical', parsed };
}

function freshSandbox(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xls511-${label}-`));
  const cfgDir = path.join(dir, 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  return cfgDir;
}

// ---------------------------------------------------------------------------
// ARM 1 / ARM 2 — the property
// ---------------------------------------------------------------------------

function runKeySurvivalArm(modPath, label) {
  const cfgDir = freshSandbox(label);
  const prevEnv = process.env.XFA_CONFIG_DIR;
  process.env.XFA_CONFIG_DIR = cfgDir;
  try {
    const mod = loadFresh(modPath);

    // Seed a real config, through the module's own writer, with no stub armed.
    mod.writeConfig({ api_key: ORIGINAL_KEY, client_id: 'client-511', telemetry: true, consent_version: 1 });
    const seeded = keyOnDisk(cfgDir);
    if (seeded.state !== 'INTACT') {
      return { ok: false, vacuous: true, why: `could not seed a config to threaten: ${seeded.state} — ${seeded.detail}` };
    }

    // Now update ONE unrelated field, and have the write fail. mergeConfig reads the whole config,
    // merges, and writes the union back — so this one-field update is what puts the key in play.
    const stub = armWriteFailure(cfgDir);
    let threw = null;
    try {
      mod.mergeConfig({ telemetry: false });
    } catch (e) {
      threw = e;
    } finally {
      stub.restore();
    }

    if (stub.fired === 0) {
      return {
        ok: false,
        vacuous: true,
        why: 'the simulated ENOSPC never fired — no write was exercised, so a surviving key proves nothing',
      };
    }

    const after = keyOnDisk(cfgDir);
    return {
      ok: after.state === 'INTACT',
      vacuous: false,
      state: after.state,
      why: after.detail,
      fired: stub.fired,
      threw: threw ? (threw.code || threw.message) : '(the write did not throw)',
    };
  } catch (e) {
    return { ok: false, vacuous: true, why: `arm could not run: ${e.message}` };
  } finally {
    if (prevEnv === undefined) delete process.env.XFA_CONFIG_DIR;
    else process.env.XFA_CONFIG_DIR = prevEnv;
  }
}

// ---------------------------------------------------------------------------
// ARM 3 — the permission property must survive the fix
// ---------------------------------------------------------------------------

function runPermissionArm(modPath, label) {
  const results = [];
  const prevEnv = process.env.XFA_CONFIG_DIR;

  // (a) A pre-XLS-408 config.json sits at 0644. The fix must still land the key at 0600 — an
  //     atomic rename must not inherit the old file's perms, or it trades data loss for disclosure.
  try {
    const cfgDir = freshSandbox(`${label}-mode`);
    process.env.XFA_CONFIG_DIR = cfgDir;
    const p = path.join(cfgDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ api_key: 'old', client_id: 'old' }) + '\n');
    fs.chmodSync(p, 0o644);
    if ((fs.statSync(p).mode & 0o777) !== 0o644) {
      results.push({ name: 'existing 0644 config is rewritten 0600', ok: false, detail: 'could not stage a 0644 file' });
    } else {
      const mod = loadFresh(modPath);
      mod.writeConfig({ api_key: ORIGINAL_KEY, client_id: 'client-511' });
      const mode = fs.statSync(p).mode & 0o777;
      results.push({
        name: 'existing 0644 config is rewritten 0600',
        ok: mode === 0o600,
        detail: `final mode 0${mode.toString(8)}`,
      });
    }
  } catch (e) {
    results.push({ name: 'existing 0644 config is rewritten 0600', ok: false, detail: `threw: ${e.message}` });
  }

  // (b) A symlink planted at the config path must still be REFUSED, and the key must not be
  //     written through it to the attacker's file.
  try {
    const cfgDir = freshSandbox(`${label}-symlink`);
    process.env.XFA_CONFIG_DIR = cfgDir;
    const target = path.join(path.dirname(cfgDir), 'attacker-readable.json');
    fs.writeFileSync(target, '{}\n');
    fs.symlinkSync(target, path.join(cfgDir, 'config.json'));

    const mod = loadFresh(modPath);
    let code = null;
    try {
      mod.writeConfig({ api_key: ORIGINAL_KEY, client_id: 'client-511' });
    } catch (e) {
      code = e && e.code;
    }
    const leaked = fs.readFileSync(target, 'utf8').includes(ORIGINAL_KEY);
    results.push({
      name: 'symlink at the config path is refused',
      ok: code === 'SYMLINK_REJECTED' && !leaked,
      detail: `refusal=${code || '(no throw)'} keyLeakedThroughLink=${leaked}`,
    });
  } catch (e) {
    results.push({ name: 'symlink at the config path is refused', ok: false, detail: `threw: ${e.message}` });
  }

  if (prevEnv === undefined) delete process.env.XFA_CONFIG_DIR;
  else process.env.XFA_CONFIG_DIR = prevEnv;
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  const modFlag = argv.indexOf('--module');
  const localModule = modFlag !== -1 ? path.resolve(argv[modFlag + 1]) : null;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xls511-pkgs-'));
  let subject;

  if (localModule) {
    if (!fs.existsSync(localModule)) {
      log(`XLS-511 CHECK: INDETERMINATE — --module ${localModule} does not exist`);
      return INDETERMINATE;
    }
    subject = { modPath: localModule, version: `LOCAL ${localModule}`, published: false };
    log(`SUBJECT: ${subject.version}`);
    log('NOTE: a local module is a DEV proof. The card\'s verdict is the PUBLISHED surface — rerun with no --module.\n');
  } else {
    try {
      const got = packAndExtract('xlsx-for-ai@latest', path.join(work, 'latest'));
      subject = { ...got, published: true };
      log(`SUBJECT: PUBLISHED xlsx-for-ai@${got.version} (npm pack xlsx-for-ai@latest)\n`);
    } catch (e) {
      log(`XLS-511 CHECK: INDETERMINATE — could not fetch the published package: ${e.message}`);
      return INDETERMINATE;
    }
  }

  // ARM 2 first: if the red arm cannot fire, nothing this check says about ARM 1 is worth reading.
  let redArm;
  try {
    const v = packAndExtract(`xlsx-for-ai@${RED_ARM_VERSION}`, path.join(work, 'redarm'));
    redArm = runKeySurvivalArm(v.modPath, 'redarm');
  } catch (e) {
    log(`XLS-511 CHECK: INDETERMINATE — could not fetch the ${RED_ARM_VERSION} red arm: ${e.message}`);
    return INDETERMINATE;
  }

  log(`ARM 2 (RED ARM, xlsx-for-ai@${RED_ARM_VERSION} — MUST destroy the key):`);
  log(`  on-disk after failed write: ${redArm.state || 'n/a'} — ${redArm.why}`);
  if (redArm.vacuous) {
    log(`\nXLS-511 CHECK: INDETERMINATE — the red arm did not run: ${redArm.why}`);
    return INDETERMINATE;
  }
  if (redArm.ok) {
    log(`\nXLS-511 CHECK: INDETERMINATE — ${RED_ARM_VERSION} did NOT lose the key, so this check cannot`);
    log('  discriminate the defect it exists to catch. Refusing to render a verdict on ARM 1.');
    return INDETERMINATE;
  }
  log(`  WITNESSED: the key is destroyed on ${RED_ARM_VERSION} (${redArm.fired} write(s) failed, threw ${redArm.threw})`);
  log('  -> the arm can detect the defect. ARM 1 is now meaningful.\n');

  // ARM 1 — the property, on the subject.
  const arm1 = runKeySurvivalArm(subject.modPath, 'subject');
  log('ARM 1 (the property — a failed write MUST leave the key intact):');
  log(`  on-disk after failed write: ${arm1.state || 'n/a'} — ${arm1.why}`);
  if (!arm1.vacuous) log(`  (${arm1.fired} write(s) failed with ENOSPC; writeConfig threw ${arm1.threw})`);

  // ARM 3 — the perms property.
  const arm3 = runPermissionArm(subject.modPath, 'subject');
  log('\nARM 3 (the permission property must SURVIVE the fix):');
  for (const r of arm3) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);

  const arm3ok = arm3.every((r) => r.ok);

  log('');
  if (arm1.vacuous) {
    log(`XLS-511 CHECK: INDETERMINATE — ARM 1 did not run: ${arm1.why}`);
    return INDETERMINATE;
  }
  if (!arm1.ok) {
    log('XLS-511 CHECK: RED — a failed config write DESTROYS the user\'s API key.');
    log(`  Measured on: ${subject.version}`);
    log(`  ${arm1.state}: ${arm1.why}`);
    if (subject.published) {
      log('  This is LIVE on the bytes users install. Fixing main does not un-ship it — publish the fix.');
    }
    return RED;
  }
  if (!arm3ok) {
    log('XLS-511 CHECK: RED — the key survives, but the permission property REGRESSED.');
    log('  The fix must not trade a data-loss bug for a key-disclosure bug.');
    return RED;
  }
  log('XLS-511 CHECK: GREEN — a failed config write leaves the API key intact,');
  log('  and the 0600 + symlink-refusal defences still hold.');
  log(`  Measured on: ${subject.version}`);
  return GREEN;
}

// process.exit() would discard buffered stdout on a pipe — and it is the FAIL path that is longest
// and gets truncated. Set the code and let the runtime drain.
process.exitCode = main(process.argv.slice(2));
