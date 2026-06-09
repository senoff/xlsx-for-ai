'use strict';

/**
 * Register the xlsx-for-ai MCP server into Claude Code's user-scope config
 * (~/.claude.json, top-level `mcpServers`). Desktop is intentionally NOT
 * touched — it stays on the auditable drag-drop .mcpb bundle.
 *
 * Design decisions (resolved from the spec-gate):
 *  - Secret-safe logging: we only ever log the xlsx-for-ai entry's command
 *    path (old -> new). We never print other servers, and never env values.
 *  - Fail mode by context: in 'cli' mode a missing global bin is fatal
 *    (exit non-zero); in 'postinstall' mode we warn + skip and never throw,
 *    so `npm install` can't be aborted by a PATH quirk.
 *  - The xlsx-for-ai entry is FULLY REPLACED with the minimal stdio shape.
 *    Other servers and other top-level keys are preserved untouched.
 *  - Concurrency: we re-stat the file just before rename; if it changed
 *    since we read it, we abort with a warning rather than clobber a
 *    concurrent writer's changes.
 *
 * Test isolation: XFA_CLAUDE_CONFIG overrides the ~/.claude.json path.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SERVER_KEY = 'xlsx-for-ai';

function claudeConfigPath() {
  return process.env.XFA_CLAUDE_CONFIG || path.join(os.homedir(), '.claude.json');
}

// Cross-platform PATH scan for an executable. Returns the absolute path or
// null. Avoids a `/bin/sh -c 'command -v'` call, which has no POSIX shell on
// Windows and so always failed there — breaking `setup` on a major platform.
function whichBin(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // On Windows the bin carries an extension from PATHEXT (e.g. xlsx-for-ai-mcp.cmd).
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        // X_OK checks the exec bit on POSIX; on Windows it degrades to F_OK
        // (existence), which is the right semantics for a PATHEXT match.
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) { /* not here — keep looking */ }
    }
  }
  return null;
}

// Resolve the global xlsx-for-ai-mcp bin. Returns the absolute path or null.
function resolveGlobalBin() {
  // Test override so we don't depend on a real global install.
  if (process.env.XFA_GLOBAL_BIN) return process.env.XFA_GLOBAL_BIN;
  return whichBin('xlsx-for-ai-mcp');
}

// Treat an entry as stale if its command is missing, isn't the resolved
// global bin, or routes through npx (the per-launch network/cache-staleness
// class we are explicitly removing).
function isStaleEntry(entry, globalBin) {
  if (!entry || typeof entry !== 'object') return true;
  const cmd = String(entry.command || '');
  if (!cmd) return true;
  if (cmd.includes('npx') || cmd.includes('_npx')) return true;
  if (Array.isArray(entry.args) && entry.args.some((a) => String(a).includes('npx'))) return true;
  return cmd !== globalBin;
}

function minimalEntry(globalBin) {
  return { type: 'stdio', command: globalBin, args: [], env: {} };
}

function readConfigRaw(p) {
  // Returns { obj, mtimeMs, existed, parseError }.
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (_) {
    return { obj: null, mtimeMs: 0, existed: false, parseError: false };
  }
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Valid JSON but a non-object shape (array, string, number, null) is not a
    // config we can merge into — treat it like a parse error so it routes
    // through backup-and-skip rather than crashing on `config.mcpServers = {}`.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { obj: null, mtimeMs: stat.mtimeMs, mode: stat.mode, existed: true, parseError: true };
    }
    return { obj, mtimeMs: stat.mtimeMs, mode: stat.mode, existed: true, parseError: false };
  } catch (_) {
    return { obj: null, mtimeMs: stat.mtimeMs, mode: stat.mode, existed: true, parseError: true };
  }
}

function backupPath(p) {
  // Include time so a same-day re-run never silently overwrites a backup.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${p}.bak-${ts}`;
}

// Back up a file WITHOUT widening its permissions. ~/.claude.json can hold
// other servers' tokens; copyFileSync creates the destination with default
// (often 0o644) perms, which would expose those tokens via a world-readable
// backup. Chmod the backup down to the source mode (0o600 floor when the
// source mode is unknown). Best-effort: a failure here must not abort install.
function backupPreservingMode(src, dst, srcMode) {
  const mode = (typeof srcMode === 'number' ? srcMode : 0o600) & 0o777;
  // Create the backup at the restricted mode from the first byte. copyFileSync
  // would create dst at default (often 0o644) perms and only tighten on the
  // following chmod, leaving a window where a token-bearing backup is world-
  // readable. Writing through an fd opened with `mode` closes that window; the
  // trailing chmod pins the exact mode in case umask stripped bits.
  const fd = fs.openSync(dst, 'w', mode);
  try { fs.writeFileSync(fd, fs.readFileSync(src)); }
  finally { fs.closeSync(fd); }
  try { fs.chmodSync(dst, mode); } catch (_) { /* best effort (e.g. Windows) */ }
}

function atomicWrite(p, obj, expectedMtimeMs, mode) {
  // Re-stat right before write: if the file changed since we read it, abort
  // rather than drop a concurrent writer's changes.
  if (expectedMtimeMs) {
    try {
      const now = fs.statSync(p).mtimeMs;
      if (now !== expectedMtimeMs) {
        return { ok: false, reason: 'changed-since-read' };
      }
    } catch (_) {
      // File vanished since read — fall through and create it.
    }
  }
  // ~/.claude.json can hold other servers' tokens. Never widen perms: keep
  // the original mode on update, and lock down to 0o600 on create.
  const fileMode = (typeof mode === 'number' ? mode : 0o600) & 0o777;
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.xfa-claude-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: fileMode });
  fs.renameSync(tmp, p);
  // Best-effort: the write already used `mode`, and chmod can throw on Windows
  // even on success — a throw here would crash setup after the file landed fine.
  try { fs.chmodSync(p, fileMode); } catch (_) { /* best effort (e.g. Windows) */ }
  return { ok: true };
}

// mode: 'cli' (fatal on missing bin) | 'postinstall' (warn + skip, never throw)
function registerMcpServer({ mode = 'cli', log = (m) => process.stderr.write(m) } = {}) {
  const globalBin = resolveGlobalBin();
  if (!globalBin) {
    const msg = 'xlsx-for-ai: could not resolve the global xlsx-for-ai-mcp bin (is `npm i -g xlsx-for-ai` complete?).\n';
    if (mode === 'postinstall') {
      log(msg + 'xlsx-for-ai: skipping Claude Code registration.\n');
      return { ok: false, skipped: true, reason: 'no-global-bin' };
    }
    const err = new Error(msg.trim());
    err.code = 'NO_GLOBAL_BIN';
    throw err;
  }

  const p = claudeConfigPath();
  const { obj, mtimeMs, mode: fileMode, existed, parseError } = readConfigRaw(p);

  if (parseError) {
    // Don't crash an install on a corrupt config — back it up and skip.
    const bak = backupPath(p);
    try { backupPreservingMode(p, bak, fileMode); } catch (_) { /* best effort */ }
    log(`xlsx-for-ai: ~/.claude.json is not valid JSON; backed up to ${bak} and skipped registration.\n`);
    return { ok: false, skipped: true, reason: 'invalid-json' };
  }

  const config = existed ? obj : { mcpServers: {} };
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const prev = config.mcpServers[SERVER_KEY];
  const next = minimalEntry(globalBin);

  // Secret-safe logging: only the xlsx-for-ai command path, never other keys.
  const prevCmd = prev && typeof prev === 'object' ? String(prev.command || '(none)') : '(none)';
  const alreadyCurrent = prev && !isStaleEntry(prev, globalBin) && prevCmd === globalBin;

  if (alreadyCurrent) {
    log(`xlsx-for-ai: Claude Code already points at ${globalBin} — no change.\n`);
    return { ok: true, changed: false, command: globalBin };
  }

  config.mcpServers[SERVER_KEY] = next;

  // Back up before mutating an existing file.
  if (existed) {
    const bak = backupPath(p);
    try { backupPreservingMode(p, bak, fileMode); } catch (_) { /* best effort */ }
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }

  const res = atomicWrite(p, config, existed ? mtimeMs : 0, existed ? fileMode : 0o600);
  if (!res.ok) {
    log('xlsx-for-ai: ~/.claude.json changed during registration; aborted to avoid clobbering concurrent edits. Re-run `xlsx-for-ai-mcp setup`.\n');
    return { ok: false, skipped: true, reason: res.reason };
  }

  log(`xlsx-for-ai: registered Claude Code MCP server (${prevCmd} -> ${globalBin}).\n`);
  return { ok: true, changed: true, command: globalBin };
}

function unregisterMcpServer({ log = (m) => process.stderr.write(m) } = {}) {
  const p = claudeConfigPath();
  const { obj, mtimeMs, mode, existed, parseError } = readConfigRaw(p);
  if (!existed || parseError || !obj.mcpServers || !obj.mcpServers[SERVER_KEY]) {
    log('xlsx-for-ai: no Claude Code entry to remove.\n');
    return { ok: true, changed: false };
  }
  delete obj.mcpServers[SERVER_KEY];
  const bak = backupPath(p);
  try { backupPreservingMode(p, bak, mode); } catch (_) { /* best effort */ }
  const res = atomicWrite(p, obj, mtimeMs, mode);
  if (!res.ok) {
    log('xlsx-for-ai: ~/.claude.json changed during uninstall; aborted. Re-run `xlsx-for-ai-mcp setup --uninstall`.\n');
    return { ok: false, skipped: true, reason: res.reason };
  }
  log('xlsx-for-ai: removed Claude Code MCP server entry.\n');
  return { ok: true, changed: true };
}

module.exports = {
  SERVER_KEY,
  claudeConfigPath,
  resolveGlobalBin,
  isStaleEntry,
  registerMcpServer,
  unregisterMcpServer,
};
