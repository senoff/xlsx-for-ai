'use strict';

/**
 * ~/.xlsx-for-ai/config.json — unified config for v2.0+
 *
 * Extends the v1.5.x telemetry config keys so upgrades are non-breaking.
 *
 * Full shape (all keys optional):
 * {
 *   "telemetry": true,
 *   "consented_at": "<ISO>",
 *   "consent_version": 1,
 *   "client_id": "<uuid>",
 *   "api_key": "<opaque>",
 *   "registered_at": "<ISO>"
 * }
 *
 * Uses XFA_CONFIG_DIR env var for test isolation (same as v1.5.x).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CURRENT_CONSENT_VERSION = 1;

function configDir() {
  return process.env.XFA_CONFIG_DIR || path.join(os.homedir(), '.xlsx-for-ai');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

// config.json holds `api_key`, which client.js sends as `Authorization: Bearer`. It is a
// credential, so it is owner-only — the same treatment mcp-register.js gives other products'
// tokens, and fd-bound the way fileToB64 (mcp.js) reads them.
//
// Three things here are deliberate:
//
//   * The `mode` on open only applies when the file is CREATED. On an existing file it is
//     silently ignored — and an existing file is precisely the exposed case, since every
//     install that registered before this fix already has a 0644 config.json. The fchmod is
//     therefore not belt-and-braces; it is the half of the fix that reaches those users.
//
//   * That fchmod is VERIFIED rather than assumed. Swallowing its error would restore exactly
//     the exposure this function exists to close, and do it silently — and a file we cannot
//     chmod is usually a file we do not own, which is an attack signal, not a nit.
//
//   * We secure the fd BEFORE writing any secret bytes, and never truncate the live file, so a
//     refusal leaves the user's existing config intact instead of destroying their key on the
//     way out.
//
//   * The write is ATOMIC: a temp file in the SAME directory, secured and fsynced, then renamed
//     over the target. The previous shape — ftruncate(fd, 0) then write(fd) — left a window in
//     which the config was EMPTY on disk, so a crash, a kill, or a full disk between those two
//     calls destroyed the user's key and left nothing behind. rename(2) is atomic on POSIX:
//     a reader sees either the whole old file or the whole new one, never a truncated one.
//     The temp lives in the same dir because rename is only atomic within a filesystem.
function writeConfig(data) {
  const dir = configDir();
  const p = configPath();
  const json = JSON.stringify(data, null, 2) + '\n';

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Defence in depth, so this one does NOT throw: a 0700 dir keeps others from traversing to the
  // file, but the FILE's own mode below is the load-bearing guard, and a dir we cannot tighten
  // must not take the write down with it. It is not silent either — a swallowed chmod is exactly
  // how the original 0644 defect stayed invisible. Warnings go to stderr, never stdout, which is
  // the MCP JSON-RPC transport.
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    process.emitWarning(
      `could not tighten ${dir} to 0700 (${e.code || e.message}); the config file itself is still owner-only`
    );
  }

  // A symlink at the target is an attack signal, not a nit, so we still REFUSE it rather than
  // quietly clobber it. rename(2) would replace the link itself and never write a secret byte
  // through it — safe, but silent, and silence is how the original 0644 defect survived. The
  // lstat cannot be raced into a leak: even if the link were planted after this check, rename
  // still replaces the link instead of following it. The check buys the diagnosis, not the
  // safety; the safety is structural.
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      const err = new Error(`Refusing to write the config through a symlink: ${p}`);
      err.code = 'SYMLINK_REJECTED';
      throw err;
    }
  } catch (e) {
    if (e && e.code === 'SYMLINK_REJECTED') throw e;
    if (!e || e.code !== 'ENOENT') throw e; // ENOENT = no config yet, which is the normal first run
  }

  // O_NOFOLLOW refuses a planted symlink at open time (same guard, same reason, as fileToB64).
  // It is undefined on Windows, where it degrades to 0 and symlink semantics differ anyway.
  // O_EXCL is what makes the temp path unforgeable: if an attacker pre-plants anything at this
  // name — regular file or symlink — the open FAILS instead of handing us their fd.
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let fd;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600
    );
  } catch (e) {
    if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) {
      const err = new Error(`Refusing to write the config through a symlink: ${tmp}`);
      err.code = 'SYMLINK_REJECTED';
      throw err;
    }
    throw e;
  }

  // A throw from `finally` REPLACES the exception in flight, so a bare closeSync() there could
  // swallow CONFIG_PERMS_UNSAFE and hand the caller an EBADF instead of a security refusal.
  // Hold the failure, close, and rethrow the original — the close error only surfaces if it is
  // the only thing that went wrong.
  let failure = null;
  try {
    // POSIX perms are meaningless on Windows; fstat there reports bits we cannot act on.
    if (process.platform !== 'win32') {
      fs.fchmodSync(fd, 0o600); // fd-bound: cannot be redirected by a symlink swapped in after open
      const mode = fs.fstatSync(fd).mode & 0o777;
      if (mode & 0o077) {
        const err = new Error(
          `Refusing to store the API key in a file others can read: ${p} is mode 0${mode.toString(8)} ` +
          `and could not be tightened to 0600.`
        );
        err.code = 'CONFIG_PERMS_UNSAFE';
        throw err;
      }
    }
    // Only now, with the file provably owner-only, does the key go in.
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, json, 0, 'utf8');
  } catch (e) {
    failure = e;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (closeErr) {
      if (!failure) failure = closeErr;
    }
  }
  if (failure) throw failure;
}

function mergeConfig(patch) {
  const existing = readConfig() || {};
  writeConfig({ ...existing, ...patch });
}

// --- telemetry helpers (preserved from v1.5.x) ---

function telemetryStatus() {
  const cfg = readConfig();
  if (!cfg) return 'not configured';
  if (cfg.telemetry === false) return 'disabled';
  if (cfg.telemetry === true) {
    if (cfg.consent_version !== CURRENT_CONSENT_VERSION) {
      return 'paused (consent_version mismatch)';
    }
    return 'enabled';
  }
  return 'not configured';
}

function isTelemetryActive() {
  return telemetryStatus() === 'enabled';
}

function enableTelemetry() {
  mergeConfig({
    telemetry: true,
    consented_at: new Date().toISOString(),
    consent_version: CURRENT_CONSENT_VERSION,
  });
}

function disableTelemetry() {
  mergeConfig({ telemetry: false });
}

module.exports = {
  CURRENT_CONSENT_VERSION,
  configPath,
  readConfig,
  writeConfig,
  mergeConfig,
  telemetryStatus,
  isTelemetryActive,
  enableTelemetry,
  disableTelemetry,
};
