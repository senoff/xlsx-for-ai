'use strict';

/**
 * Prune stale xlsx-for-ai install artifacts left by older `npx`-based configs
 * and shadowing global installs at non-current prefixes.
 *
 * Safety model (blessed shape):
 *  - Dry-run by default. Nothing is deleted unless { confirm: true }.
 *  - Allowlist by construction: a candidate is only ever a directory whose
 *    basename is exactly 'xlsx-for-ai' AND whose parent is 'node_modules'.
 *    No globbing of other names; slack, google-sheets, etc. can't match.
 *  - The current authoritative global install is never removed (realpath
 *    comparison guards against symlink-based collisions).
 *  - Bounded enumeration — fixed depth, fixed candidate-prefix list.
 *
 * Pure-fs implementation (no shelling to find/rm) so there is no shell-
 * injection surface and the guards are unit-testable.
 *
 * Test isolation:
 *   XFA_NPX_CACHE_DIR        base dir scanned for npx caches (def ~/.npm/_npx)
 *   XFA_PREFIX_CANDIDATES    ':'-separated prefixes to scan for globals
 *   XFA_CURRENT_GLOBAL       path to the authoritative install (never removed)
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = 'xlsx-for-ai';

function npxCacheBase() {
  return process.env.XFA_NPX_CACHE_DIR || path.join(os.homedir(), '.npm', '_npx');
}

function prefixCandidates() {
  // A defined override (even empty) is authoritative — empty means "scan no
  // prefixes", never "fall through to the real system prefixes".
  if (process.env.XFA_PREFIX_CANDIDATES !== undefined) {
    return process.env.XFA_PREFIX_CANDIDATES.split(':').filter(Boolean);
  }
  const home = os.homedir();
  const list = ['/usr/local', '/opt/homebrew', path.join(home, '.npm-global'), path.join(home, '.local')];
  // nvm: each installed node version is its own prefix.
  const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmVersions)) {
      list.push(path.join(nvmVersions, v));
    }
  } catch (_) { /* no nvm */ }
  return list;
}

function currentGlobalDir() {
  // A defined-but-empty override means "current is unknowable" (test isolation
  // and a deliberate fail-safe), not "fall through to npm".
  if (process.env.XFA_CURRENT_GLOBAL !== undefined) {
    return process.env.XFA_CURRENT_GLOBAL || null;
  }
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
    if (prefix) return path.join(prefix, 'lib', 'node_modules', PKG);
  } catch (_) { /* npm not resolvable */ }
  return null;
}

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch (_) { return null; }
}

// realpath of the package dir this module is running from — never delete self,
// even if it is a candidate (e.g. running via the very npx cache being pruned).
function selfPackageRoot() {
  try { return realpathOrNull(path.dirname(require.resolve('../package.json'))); }
  catch (_) { return null; }
}

// A candidate is valid only if it is a dir named exactly `xlsx-for-ai` whose
// immediate parent is `node_modules`. This is the load-bearing allowlist.
function isPackageDir(p) {
  if (path.basename(p) !== PKG) return false;
  if (path.basename(path.dirname(p)) !== 'node_modules') return false;
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function findNpxCacheTargets() {
  const base = npxCacheBase();
  const targets = [];
  let hashes;
  try { hashes = fs.readdirSync(base); } catch (_) { return targets; }
  for (const h of hashes) {
    const cand = path.join(base, h, 'node_modules', PKG);
    if (isPackageDir(cand)) targets.push(cand);
  }
  return targets;
}

function findShadowingGlobals(current) {
  const targets = [];
  const currentReal = current ? realpathOrNull(current) : null;
  const selfRoot = selfPackageRoot();
  for (const prefix of prefixCandidates()) {
    // Join 'lib/node_modules/<pkg>' exactly once — never double-join 'lib'.
    const cand = path.join(prefix, 'lib', 'node_modules', PKG);
    if (!isPackageDir(cand)) continue;
    const candReal = realpathOrNull(cand);
    if (currentReal && candReal && candReal === currentReal) continue; // authoritative
    if (selfRoot && candReal && candReal === selfRoot) continue;       // running module
    targets.push(cand);
  }
  return targets;
}

function runCleanup({ confirm = false, log = (m) => process.stderr.write(m) } = {}) {
  const current = currentGlobalDir();
  const currentReal = current ? realpathOrNull(current) : null;
  const selfRoot = selfPackageRoot();
  // npx caches are never the authoritative global, so they are always
  // deletable. Shadowing globals are only safe to delete when we have a
  // reliable `current` to exclude — without it we cannot prove a candidate
  // isn't the authoritative install, so we list but never delete it.
  const npxTargets = findNpxCacheTargets().map((p) => ({ p, kind: 'npx' }));
  const shadowTargets = findShadowingGlobals(current).map((p) => ({ p, kind: 'shadow' }));
  const targets = [...npxTargets, ...shadowTargets];

  if (targets.length === 0) {
    log('xlsx-for-ai cleanup: nothing stale found.\n');
    return { ok: true, removed: [], wouldRemove: [] };
  }

  const removed = [];
  const wouldRemove = [];
  for (const { p: t, kind } of targets) {
    // Final guards right before any destructive action.
    if (!isPackageDir(t)) continue;
    const tReal = realpathOrNull(t);
    if (selfRoot && tReal && tReal === selfRoot) continue;          // never delete self
    if (currentReal && tReal && tReal === currentReal) continue;    // authoritative
    // Fail-safe: with no known current, a shadowing global could BE the
    // authoritative install — list it, but never delete it.
    const deletable = confirm && !(kind === 'shadow' && !current);
    if (deletable) {
      try {
        fs.rmSync(t, { recursive: true, force: true });
        removed.push(t);
        log(`xlsx-for-ai cleanup: removed ${t}\n`);
      } catch (e) {
        log(`xlsx-for-ai cleanup: could not remove ${t}: ${e.message}\n`);
      }
    } else if (confirm) {
      // confirm set but this candidate isn't safely deletable (shadow + no current)
      wouldRemove.push(t);
      log(`xlsx-for-ai cleanup: kept ${t} — cannot confirm it is not the authoritative install.\n`);
    } else {
      wouldRemove.push(t);
      log(`xlsx-for-ai cleanup [dry-run]: would remove ${t}\n`);
    }
  }
  if (!confirm) {
    log('xlsx-for-ai cleanup: dry-run only — re-run with `--cleanup --confirm` to delete.\n');
  }
  return { ok: true, removed, wouldRemove };
}

module.exports = {
  PKG,
  isPackageDir,
  findNpxCacheTargets,
  findShadowingGlobals,
  currentGlobalDir,
  runCleanup,
};
