'use strict';

// ---------------------------------------------------------------------------
// Shared hardened file → base64 reader (XLS-815).
//
// The single local-file read path for BOTH entrypoints — the `mcp.js` stdio
// server and the `index.js` CLI. Previously `mcp.js` had this hardening and the
// CLI read files with a bare `fs.readFileSync(path).toString('base64')` guarded
// only by `existsSync`: a multi-GB file OOM'd the CLI into a generic
// "request failed" instead of a clean `FILE_TOO_LARGE`. This module IS that one
// read path so both surfaces get identical behavior and the cap can never drift
// between them.
//
// Security: only spreadsheet extensions are permitted. Any path that resolves
// to a non-allowed extension (or does not exist) is rejected immediately so a
// misbehaving agent — or a mistyped CLI argument — cannot exfiltrate or slurp
// arbitrary local files.
//
// Stability: a size cap is enforced before the synchronous read so a giant
// workbook can't OOM-kill the process (which, for the MCP server, would
// disconnect every tool for the user). The cap per file type is the service's
// own ceiling (xlsx/xlsm/xls 100 MB, csv 200 MB, anything else 10 MB), so this
// client never refuses a file the service would take. XFA_MAX_FILE_MB, if a
// person sets it, replaces those limits.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ALLOWED_READ_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv', '.ods', '.fods', '.numbers', '.tsv']);
// The service's own size ceilings, per file type, in MB. They are the same on every
// plan (a limit of capacity, never something a plan changes), and this client
// checks the same numbers so it never refuses a file the service would take
// (B1-20). Any type not listed here gets the smallest ceiling.
const SIZE_LIMITS_MB = {
  '.xlsx': 100,
  '.xlsm': 100,
  '.xls': 100,
  '.csv': 200,
};
const DEFAULT_MAX_FILE_MB = 10;
const LARGEST_LIMIT_MB = Math.max(...Object.values(SIZE_LIMITS_MB));

// XFA_MAX_FILE_MB, when a person sets it themselves, replaces the per-type limit
// for every type. Returns 0 when it is unset or not a positive number.
function envMaxFileMB() {
  const raw = process.env.XFA_MAX_FILE_MB;
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// The limit for a file with this extension (with or without the leading dot).
// With no extension given it is the largest ceiling.
function getMaxFileMB(ext) {
  const env = envMaxFileMB();
  if (env) return env;
  if (ext === undefined) return LARGEST_LIMIT_MB;
  const key = String(ext).toLowerCase().replace(/^\.?/, '.');
  return SIZE_LIMITS_MB[key] || DEFAULT_MAX_FILE_MB;
}

// One sentence a person can act on, for a chat or a terminal: the size, the
// limit, that no plan changes it, and what to do. It names no setting, except
// when the person set XFA_MAX_FILE_MB themselves and that setting is the limit.
function fileTooLargeSentence(err) {
  const size = err && Number.isFinite(err.sizeMB) ? `${err.sizeMB.toFixed(1)} MB` : 'larger than the limit';
  const ext = err && err.ext ? String(err.ext) : '';
  const limit = err && Number.isFinite(err.limitMB) ? err.limitMB : DEFAULT_MAX_FILE_MB;
  const kind = ext ? ` for ${ext} files` : '';
  let text = `this file is ${size}, over the ${limit} MB limit${kind}. The limit is the same on every plan, so changing plans will not lift it.`;
  if (err && err.limitFromEnv) {
    text += ' This limit was set by the XFA_MAX_FILE_MB setting on this computer.';
  } else if (ext && ext !== '.csv' && SIZE_LIMITS_MB['.csv'] > limit) {
    text += ` Save the data as a .csv (up to ${SIZE_LIMITS_MB['.csv']} MB) or split the workbook into smaller files, then try again.`;
  } else {
    text += ' Split the file into smaller files, then try again.';
  }
  return text;
}

// Expand a leading `~` to the user's home dir so tilde-prefixed paths the
// model passes ("~/Desktop/foo.xlsx") don't dead-end with ENOENT. SPM P1
// 2026-06-06 "secondary" finding — a cheap friction-reducer.
// Only the leading character; we don't try to resolve `~user/foo` patterns.
function expandTilde(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A web link (or a Google Sheets / Drive address) given where a file path goes.
// This door reads files on the person's own computer only, so say so and say
// what to do instead, rather than "File not found".
const LINK_PATTERN = /^\s*(?:https?:\/\/|(?:docs|drive)\.google\.com\/)/i;
const LINK_NOT_SUPPORTED_MESSAGE =
  'this tool reads files saved on this computer only, so it cannot open a web link or a Google Sheets link. ' +
  'Download the file and give its file path instead, or use the hosted xlsx-for-ai connector, which can open links directly.';

function looksLikeLink(p) {
  return typeof p === 'string' && LINK_PATTERN.test(p);
}

function readFileToBase64(filePath) {
  if (looksLikeLink(filePath)) {
    const err = new Error('A web link was given where a file path is expected.');
    err.code = 'LINK_NOT_SUPPORTED';
    throw err;
  }
  const resolved = path.resolve(expandTilde(filePath));

  // Open the file once and operate on the fd from here on. fstatSync and the
  // subsequent read both bind to the inode the fd points at, so even if the
  // path is swapped after the size check the bytes we hash are the bytes we
  // sized — the size-cap TOCTOU is closed.
  // Reject symlinks explicitly BEFORE opening. O_NOFOLLOW below refuses them at
  // open time where the platform supports it, but it is 0 (a no-op) on Windows
  // and some builds — there, an allowed-extension symlink (evil.xlsx -> /etc/passwd)
  // would otherwise be followed with only the LINK's own extension checked,
  // defeating the allowlist and exposing arbitrary files. lstat refuses the link
  // on every platform. (The fstat-on-fd read below binds to the opened inode and
  // closes the size TOCTOU; this lstat closes the follow-the-link bypass.)
  let lst;
  try {
    lst = fs.lstatSync(resolved);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`File not found: ${resolved}`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    throw e;
  }
  if (lst.isSymbolicLink()) {
    const err = new Error(`Refusing to read symlink: ${resolved}`);
    err.code = 'SYMLINK_REJECTED';
    throw err;
  }

  // O_NOFOLLOW (where available) refuses symlinks at open time too — kept as
  // defense-in-depth against a swap between the lstat above and this open. It's
  // undefined on Windows, where we fall back to 0 and the lstat is the guard.
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`File not found: ${resolved}`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    if (e && e.code === 'ELOOP') {
      const err = new Error(`Refusing to read symlink: ${resolved}`);
      err.code = 'SYMLINK_REJECTED';
      throw err;
    }
    throw e;
  }

  try {
    const stat = fs.fstatSync(fd);

    // Close the lstat->open TOCTOU on platforms where O_NOFOLLOW is a no-op
    // (Windows, some builds): an attacker could swap the path to a symlink
    // between the pre-open lstat and the open, and the open would follow it.
    // Re-lstat the path now and confirm it still names the SAME non-symlink
    // inode the fd is bound to — a swap to a symlink trips isSymbolicLink(), a
    // swap to a different file changes (dev,ino). Where O_NOFOLLOW is real the
    // open already refused any symlink, so this recheck is skipped.
    if (!O_NOFOLLOW) {
      let post = null;
      try { post = fs.lstatSync(resolved); } catch { /* vanished mid-open */ }
      if (!post || post.isSymbolicLink() || post.ino !== stat.ino || post.dev !== stat.dev) {
        const err = new Error(`Refusing to read symlink or swapped path: ${resolved}`);
        err.code = 'SYMLINK_REJECTED';
        throw err;
      }
    }

    if (!stat.isFile()) {
      const err = new Error(`Not a regular file: ${resolved}`);
      err.code = 'NOT_REGULAR_FILE';
      throw err;
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_READ_EXTENSIONS.has(ext)) {
      const err = new Error(
        `Blocked: "${ext}" is not an allowed spreadsheet extension. ` +
        `Allowed: ${[...ALLOWED_READ_EXTENSIONS].join(', ')}`
      );
      err.code = 'DISALLOWED_EXTENSION';
      throw err;
    }

    const maxMB = getMaxFileMB(ext);
    if (stat.size > maxMB * 1024 * 1024) {
      const sizeMB = stat.size / (1024 * 1024);
      const err = new Error(
        `File too large: ${sizeMB.toFixed(1)} MB exceeds the ${maxMB} MB limit for ${ext} files.`
      );
      err.code = 'FILE_TOO_LARGE';
      err.sizeMB = sizeMB;
      err.limitMB = maxMB;
      err.ext = ext;
      err.limitFromEnv = envMaxFileMB() > 0;
      throw err;
    }

    // Read exactly stat.size bytes from the fd into a pre-sized buffer. If
    // the file grows between fstat and now, the extra bytes are NOT read —
    // we never allocate more than the validated cap. If the file shrinks
    // (short read), we encode what we got and stop. This closes the
    // grow-after-stat bypass on the size cap.
    const buf = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const chunk = fs.readSync(fd, buf, bytesRead, stat.size - bytesRead, null);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    return buf.subarray(0, bytesRead).toString('base64');
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
  }
}

module.exports = {
  readFileToBase64,
  looksLikeLink,
  LINK_NOT_SUPPORTED_MESSAGE,
  expandTilde,
  getMaxFileMB,
  fileTooLargeSentence,
  SIZE_LIMITS_MB,
  ALLOWED_READ_EXTENSIONS,
  DEFAULT_MAX_FILE_MB,
};
