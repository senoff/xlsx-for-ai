'use strict';

// ---------------------------------------------------------------------------
// A pasted link in place of a file path (XLS-4526, audit B1-23 / B2-11).
//
// The hosted connector opens a web link or a shared Google Sheet directly. This
// door used to refuse every link. Now a public http(s) link, a Google Sheets
// link or a Google Drive file link is downloaded to a private temp file, and
// that file then goes through the same hardened local read as any other file
// (extension allowlist, per-type size limit). A link that cannot be downloaded,
// or that does not return a spreadsheet, gets one plain sentence saying why and
// what to do next.
//
// What is fetched is checked before anything is sent on: the bytes must be a
// workbook (zip or OLE2 signature) or, for a .csv/.tsv link or a text/csv
// answer, plain text that is not a web page. So a link can only ever hand the
// service a spreadsheet, never an arbitrary page.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { looksLikeLink, getMaxFileMB, ALLOWED_READ_EXTENSIONS } = require('./read-file');

const FETCH_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;

const LINK_NEXT_STEP =
  'If it is a Google Sheet, share it as "Anyone with the link can view" and try again. ' +
  'Otherwise download the file and give its file path, or use the hosted xlsx-for-ai connector, which can open links directly.';

// One sentence for a person, for a chat or a terminal.
function linkFailedSentence(err) {
  const why = err && err.reason ? err.reason : 'it could not be downloaded';
  return `could not open that link: ${why}. ${LINK_NEXT_STEP}`;
}

// A Google Sheets or Drive address becomes the address that downloads the file.
// Anything else is used as given.
function downloadUrlFor(link) {
  let u;
  try {
    u = new URL(link.trim().replace(/^(docs|drive)\.google\.com\//i, 'https://$1.google.com/'));
  } catch (_) {
    throw linkError('it is not a complete web address');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'docs.google.com') {
    const m = u.pathname.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    if (m) return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`, ext: '.xlsx' };
  }
  if (host === 'drive.google.com') {
    const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const id = m ? m[1] : u.searchParams.get('id');
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
      return { url: `https://drive.google.com/uc?export=download&id=${id}`, ext: null };
    }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw linkError('only web links (http or https) can be opened');
  }
  const ext = path.extname(u.pathname).toLowerCase();
  return { url: u.toString(), ext: ALLOWED_READ_EXTENSIONS.has(ext) ? ext : null };
}

function linkError(reason, code = 'LINK_FETCH_FAILED') {
  const err = new Error(`Link could not be opened: ${reason}`);
  err.code = code;
  err.reason = reason;
  return err;
}

const ZIP_FAMILY = new Set(['.xlsx', '.xlsm', '.xlsb', '.ods', '.numbers']);

// The file type the downloaded bytes really are, or null when they are not a
// spreadsheet. The link's own extension wins only where the bytes agree with it.
function sniffExtension(buf, linkExt, contentType) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return ZIP_FAMILY.has(linkExt) ? linkExt : '.xlsx';
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
    return '.xls';
  }
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  const isPage = head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<html');
  if (isPage) return null;
  if (linkExt === '.fods' && head.startsWith('<?xml')) return '.fods';
  if (head.startsWith('<')) return null;
  const ct = String(contentType || '').toLowerCase();
  if (linkExt === '.csv' || linkExt === '.tsv') return linkExt;
  if (ct.includes('text/csv')) return '.csv';
  if (ct.includes('text/tab-separated-values')) return '.tsv';
  return null;
}

async function fetchWithRedirects(url, signal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal, headers: { 'user-agent': 'xlsx-for-ai' } });
    } catch (e) {
      if (e && e.name === 'AbortError') throw linkError('the download took too long');
      throw linkError('the address could not be reached');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw linkError('the link redirected somewhere that is not a web address');
      current = next.toString();
      try { await res.body?.cancel(); } catch (_) { /* nothing to drain */ }
      continue;
    }
    return res;
  }
  throw linkError('the link redirected too many times');
}

// Download a link to a private temp file. Returns { path, cleanup }; the caller
// reads the file and then calls cleanup(). Throws LINK_FETCH_FAILED or
// LINK_NOT_SPREADSHEET (with .reason) or FILE_TOO_LARGE.
async function downloadLink(link) {
  const target = downloadUrlFor(link);
  const capMB = getMaxFileMB();
  const capBytes = capMB * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithRedirects(target.url, controller.signal);
    if (!res.ok) {
      try { await res.body?.cancel(); } catch (_) { /* nothing to drain */ }
      const why = res.status === 404 ? 'nothing was found at that address (404)'
        : (res.status === 401 || res.status === 403) ? `the file is not shared publicly (${res.status})`
        : `the site answered ${res.status}`;
      throw linkError(why);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > capBytes) throw tooLarge(declared, capMB);

    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > capBytes) {
          controller.abort();
          throw tooLarge(total, capMB);
        }
        chunks.push(chunk);
      }
    } catch (e) {
      if (e && e.code === 'FILE_TOO_LARGE') throw e;
      if (e && e.name === 'AbortError') throw linkError('the download took too long');
      throw linkError('the download was cut off');
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (buf.length === 0) throw linkError('the link returned an empty file');

    const ext = sniffExtension(buf, target.ext, res.headers.get('content-type'));
    if (!ext) throw linkError('the link returned a web page, not a spreadsheet', 'LINK_NOT_SPREADSHEET');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-link-'));
    const file = path.join(dir, `download${ext}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    return { path: file, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } } };
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(bytes, limitMB) {
  const err = new Error(`File too large: the link's file is over the ${limitMB} MB limit.`);
  err.code = 'FILE_TOO_LARGE';
  err.sizeMB = bytes / (1024 * 1024);
  err.limitMB = limitMB;
  err.limitFromEnv = !!process.env.XFA_MAX_FILE_MB;
  return err;
}

module.exports = { downloadLink, downloadUrlFor, sniffExtension, linkFailedSentence, looksLikeLink, LINK_NEXT_STEP };
