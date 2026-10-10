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
// disconnect every tool for the user). Override via XFA_MAX_FILE_MB; default
// is 50 MB.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ALLOWED_READ_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv', '.ods', '.fods', '.numbers', '.tsv']);
const DEFAULT_MAX_FILE_MB = 50;

function getMaxFileMB() {
  const raw = process.env.XFA_MAX_FILE_MB;
  if (!raw) return DEFAULT_MAX_FILE_MB;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_MB;
  return parsed;
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

function readFileToBase64(filePath) {
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

    const maxMB = getMaxFileMB();
    if (stat.size > maxMB * 1024 * 1024) {
      const sizeMB = stat.size / (1024 * 1024);
      const err = new Error(
        `File too large: ${sizeMB.toFixed(1)} MB exceeds the ${maxMB} MB cap. ` +
        `Set XFA_MAX_FILE_MB to a higher value to allow larger workbooks. ` +
        `(The cap protects against OOM on synchronous base64 load — ` +
        `a 200 MB workbook would allocate ~267 MB of base64 before any API call.)`
      );
      err.code = 'FILE_TOO_LARGE';
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
  expandTilde,
  getMaxFileMB,
  ALLOWED_READ_EXTENSIONS,
  DEFAULT_MAX_FILE_MB,
};
