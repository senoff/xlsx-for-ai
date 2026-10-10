'use strict';

/**
 * Best-effort self-upgrade check for the globally-installed xlsx-for-ai CLI.
 *
 * Design:
 *  - Fire-and-forget. Called detached from mcp.js main() after the stdio
 *    transport is connected; we never await it and never let it throw into
 *    the server. A hung network or a bad registry response is a no-op.
 *  - Quiet by default and STDERR-ONLY. mcp.js speaks the MCP protocol over
 *    stdout, so this module must never write a byte to stdout.
 *  - Throttled: at most one network check per 24h, recorded in
 *    ~/.xlsx-for-ai/upgrade-check.json (XFA_CONFIG_DIR-aware via config.js).
 *  - Opt-out: XFA_NO_AUTO_UPDATE=1 (and CI) disables it entirely.
 *  - Conservative action: only run `npm i -g` in place when the install dir
 *    is actually writable; otherwise print a one-line hint and move on.
 *
 * Test isolation:
 *   XFA_CONFIG_DIR        relocates the throttle cache
 *   XFA_LATEST_VERSION    short-circuits the registry fetch (returns this)
 *   XFA_NO_AUTO_UPDATE=1  disables the check
 *   XFA_INSTALL_ROOT      overrides the writability-probe target dir
 *   XFA_UPGRADE_NOEXEC=1  decides-but-doesn't-exec `npm i -g` (test seam)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { configPath } = require('./config');

const PKG = 'xlsx-for-ai';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cacheFile() {
  return path.join(path.dirname(configPath()), 'upgrade-check.json');
}

// Parse `MAJOR.MINOR.PATCH[-prerelease][+build]`. Returns null on anything that
// isn't clean semver-core — the fail-safe that keeps a malformed registry
// response or a weird local version from ever triggering an upgrade.
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
  // Build metadata (after `+`) is intentionally discarded — it has no
  // precedence per semver §10.
}

// semver §11 prerelease precedence: dot-separated identifiers, numeric compared
// numerically, numeric < alphanumeric, a longer identifier set wins ties.
function comparePre(a, b) {
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = +as[i] - +bs[i];
      if (d) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric has lower precedence than alphanumeric
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return 0;
}

// True iff `latest` is strictly newer than `current`. Fail-safe false on
// unparseable input; a prerelease ranks below its release; build metadata is
// ignored. e.g. isNewer('1.0.0-beta','1.0.0') === false.
function isNewer(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  if (a.pre && !b.pre) return false; // prerelease of the same core isn't newer
  if (!a.pre && b.pre) return true;  // the release of current's prerelease is
  if (a.pre && b.pre) return comparePre(a.pre, b.pre) > 0;
  return false; // identical core, both releases
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); }
  catch (_) { return {}; }
}

function writeCache(obj) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (_) { /* best effort — a missing cache just means we re-check sooner */ }
}

function dueForCheck(cache) {
  return Date.now() - Number(cache.lastCheck || 0) >= CHECK_INTERVAL_MS;
}

function fetchLatestVersion(timeoutMs = 3000, unref = false) {
  if (process.env.XFA_LATEST_VERSION !== undefined) {
    return Promise.resolve(process.env.XFA_LATEST_VERSION || null);
  }
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'registry.npmjs.org',
      path: `/${PKG}/latest`,
      headers: { accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) { req.destroy(); resolve(null); } });
      res.on('end', () => {
        try { resolve(JSON.parse(body).version || null); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    // The terminal command must never wait on this lookup: with the socket
    // unref'd, the command exits as soon as its own work is done.
    if (unref) req.on('socket', (s) => { if (s && s.unref) s.unref(); });
  });
}

// The directory this module is installed in. When run as a global install
// that's the package root we'd upgrade in place.
function selfRoot() {
  if (process.env.XFA_INSTALL_ROOT !== undefined) return process.env.XFA_INSTALL_ROOT || null;
  try { return path.dirname(require.resolve('../package.json')); }
  catch (_) { return null; }
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; }
  catch (_) { return false; }
}

// Remember that this copy could not bring itself up to date, so the notice below
// can be shown wherever the person is: in a tool result, which a host does show,
// not only on stderr, which it does not (B3-6).
function markManualUpdate(manual) {
  writeCache({ ...readCache(), manual });
}

function runUpgrade(log) {
  if (process.env.XFA_UPGRADE_NOEXEC === '1') return; // test seam: decide, don't exec
  // npm install -g routinely emits more than the 1MB default maxBuffer; without
  // a raised ceiling the child is killed with ENOBUFS and a healthy upgrade is
  // misreported as a failure. 64MB comfortably covers npm's noisiest output.
  execFile('npm', ['install', '-g', `${PKG}@latest`], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err) => {
    if (err) {
      markManualUpdate(true);
      log(`xlsx-for-ai: auto-upgrade failed; run \`npm i -g ${PKG}@latest\` to update.\n`);
    } else {
      markManualUpdate(false);
      log(`xlsx-for-ai: upgraded ${PKG} to latest (takes effect next launch).\n`);
    }
  });
}

// Returns a Promise that always resolves (never rejects). The result object is
// for tests/observability; callers in mcp.js ignore it.
//
//   noticeOnly  look up the newest version and record it, but never install
//               anything (the terminal command uses this: it must not change the
//               install it is running from).
function checkForUpgrade({ currentVersion, log = (m) => process.stderr.write(m), noticeOnly = false } = {}) {
  if (process.env.XFA_NO_AUTO_UPDATE === '1') return Promise.resolve({ skipped: 'opt-out' });
  if (process.env.CI) return Promise.resolve({ skipped: 'ci' });

  const cache = readCache();
  if (!dueForCheck(cache)) return Promise.resolve({ skipped: 'throttled' });

  return fetchLatestVersion(3000, noticeOnly).then((latest) => {
    writeCache({ ...cache, lastCheck: Date.now(), latest: latest || cache.latest || null });
    if (!latest || !isNewer(latest, currentVersion)) {
      markManualUpdate(false);
      return { upToDate: true, latest };
    }

    const root = selfRoot();
    if (!noticeOnly && root && isWritable(root)) {
      runUpgrade(log);
      return { upgrading: true, latest };
    }
    markManualUpdate(true);
    log(`xlsx-for-ai: a newer version (${latest}) is available — run \`npm i -g ${PKG}@latest\`.\n`);
    return { hint: true, latest };
  }).catch(() => ({ skipped: 'error' }));
}

// The sentence for a person whose copy is out of date and cannot update itself.
// It reads the answer the last check saved, so it costs no network call and is
// the same in a tool result and on a terminal. Returns '' when there is nothing
// to say: the copy is current, it can update itself, or no check has run yet.
//
// The step is written for whoever reads it where the text appears: an assistant
// that can run commands does it for the person; otherwise the person runs it in
// a terminal and restarts the app.
function updateNotice(currentVersion) {
  const cache = readCache();
  if (!cache.manual || !cache.latest || !isNewer(cache.latest, currentVersion)) return '';
  return `A newer xlsx-for-ai (${cache.latest}) is available, and this copy (${currentVersion}) could not update itself. ` +
    `To update, run \`npm install -g ${PKG}@latest\` and then restart this app. ` +
    'An assistant that can run commands can do this for the user; otherwise they run it in a terminal.';
}

module.exports = {
  PKG,
  parseSemver,
  isNewer,
  checkForUpgrade,
  updateNotice,
  fetchLatestVersion,
};
