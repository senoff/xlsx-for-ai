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

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

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
//   * We secure the file BEFORE writing any secret bytes, and we never destroy the old contents
//     until the new ones exist in full, so a refusal or a failed write leaves the user's existing
//     config intact instead of destroying their key on the way out.
//
// That last property is why this writes a temp file and renames it into place (XLS-511). The
// previous shape opened the real config and called ftruncateSync(fd, 0) before writeSync: the old
// value was destroyed while the new one existed only in memory. A write that then failed — ENOSPC
// is the reachable one, since truncating FREES space and the write is what runs out of it, plus
// EDQUOT/EIO or a short write — left an empty config and an unrecoverable API key. No crash and no
// unusual timing required. mergeConfig() made it worse: it writes the whole merged union back, so
// a failed one-field update destroyed every field.
//
// rename(2) is atomic within a filesystem, which is why the temp file MUST be created in the same
// directory as the config and not in os.tmpdir(). A reader sees the old config or the new one,
// never a truncated one.
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

  // Refuse a planted symlink at the config path. rename(2) does not follow symlinks — it replaces
  // the link itself — so the key can no longer be written THROUGH one no matter what this check
  // does. The disclosure defence is therefore rename's semantics, and this lstat exists to keep the
  // SYMLINK_REJECTED contract callers were given. That ordering is what makes the unavoidable
  // TOCTOU gap between lstat and rename harmless: losing the race costs the refusal, not the key.
  if (process.platform !== 'win32') {
    let targetStat = null;
    try {
      targetStat = fs.lstatSync(p);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e; // no config yet is the normal first-run case
    }
    if (targetStat && targetStat.isSymbolicLink()) {
      const err = new Error(`Refusing to write the config through a symlink: ${p}`);
      err.code = 'SYMLINK_REJECTED';
      throw err;
    }
  }

  // Random, not pid+timestamp: a same-UID process could predict that name and pre-create it to
  // force CONFIG_STAGING_OCCUPIED and block config writes indefinitely. Cheap to close, so close
  // it — the staging file is new surface this fix introduces, and it holds the key.
  const tmp = path.join(dir, `.config.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    // O_EXCL refuses to open if anything already sits at the temp path — including a planted
    // symlink — so the temp file is always ours and always freshly CREATED. That matters: the mode
    // argument applies only on creation and is silently ignored on an existing file.
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600
    );
  } catch (e) {
    // Deliberately NOT SYMLINK_REJECTED: that code is the contract for "the config path you asked
    // me to write is a symlink", and reusing it here would tell the caller something false about
    // THEIR path. Anything sitting at our private staging path — symlink (ELOOP) or file (EEXIST)
    // — is our own collision or someone predicting it, and either way we refuse and the config is
    // untouched.
    if (e && (e.code === 'EEXIST' || e.code === 'ELOOP' || e.code === 'EMLINK')) {
      const err = new Error(
        `Refusing to stage the config: something already exists at ${tmp} (${e.code}). ` +
        `The existing config has been left untouched.`
      );
      err.code = 'CONFIG_STAGING_OCCUPIED';
      throw err;
    }
    throw e;
  }

  // A throw from `finally` REPLACES the exception in flight, so a bare closeSync() there could
  // swallow CONFIG_PERMS_UNSAFE and hand the caller an EBADF instead of a security refusal.
  // Hold the failure, close, and rethrow the original — the close error only surfaces if it is
  // the only thing that went wrong.
  let failure = null;
  let landed = false;
  try {
    // POSIX perms are meaningless on Windows; fstat there reports bits we cannot act on.
    if (process.platform !== 'win32') {
      fs.fchmodSync(fd, 0o600); // fd-bound: cannot be redirected by a symlink swapped in after open
      const mode = fs.fstatSync(fd).mode & 0o777;
      if (mode & 0o077) {
        const err = new Error(
          `Refusing to store the API key in a file others can read: ${tmp} is mode 0${mode.toString(8)} ` +
          `and could not be tightened to 0600.`
        );
        err.code = 'CONFIG_PERMS_UNSAFE';
        throw err;
      }
    }
    // Only now, with the file provably owner-only, does the key go in.
    //
    // writeSync issues ONE write(2) and hands back a byte count; it does not loop. A filesystem
    // with room for SOME of the config returns a SHORT COUNT rather than throwing — so a single
    // unchecked writeSync can leave a truncated temp file that we would then rename over the
    // user's perfectly good config. That is this very bug, one layer down, and the rename would
    // make it worse by installing the corruption atomically.
    //
    // Loop until every byte lands, and treat no-progress as the failure it is rather than
    // spinning on it. The Buffer is not incidental: writeSync's string form takes a POSITION, not
    // an offset, and resuming a partial write by slicing a string can split a multi-byte UTF-8
    // character. Bytes are the only unit in which "how much got written" is answerable.
    const buf = Buffer.from(json, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (!(n > 0)) {
        const err = new Error(
          `Wrote only ${written} of ${buf.length} bytes of config and stopped making progress ` +
          `(is the disk full?). The existing config has been left untouched.`
        );
        err.code = 'CONFIG_SHORT_WRITE';
        throw err;
      }
      written += n;
    }
  } catch (e) {
    failure = e;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (closeErr) {
      if (!failure) failure = closeErr;
    }
  }

  // "Wrote it in full" is a claim, so check it against the filesystem rather than trusting the
  // loop above. This is a second, independent guard on the same property: it catches a truncated
  // temp file no matter which primitive produced it, and it is one stat.
  if (!failure) {
    try {
      const want = Buffer.byteLength(json, 'utf8');
      const got = fs.statSync(tmp).size;
      if (got !== want) {
        const err = new Error(
          `Refusing to install a truncated config: staged ${got} of ${want} bytes. ` +
          `The existing config has been left untouched.`
        );
        err.code = 'CONFIG_SHORT_WRITE';
        throw err;
      }
    } catch (e) {
      failure = e;
    }
  }

  // Swap in ONLY a file we wrote in full. Anything that went wrong above leaves the old config —
  // and the key in it — exactly where it was. The renamed file carries the temp file's inode and
  // its 0600 mode, which also replaces a pre-XLS-408 0644 config.json in place rather than
  // inheriting its perms: the reach that fchmod-on-the-real-file used to provide is preserved here.
  if (!failure) {
    try {
      fs.renameSync(tmp, p);
      landed = true;
    } catch (e) {
      failure = e;
    }
  }

  if (!landed) {
    // Never leave a key-bearing temp file behind. Best-effort: the real error is the one to report.
    try {
      fs.unlinkSync(tmp);
    } catch (_) { /* already gone, or never created */ }
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
