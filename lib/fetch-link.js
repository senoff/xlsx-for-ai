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
const net  = require('net');
const dns  = require('dns').promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { looksLikeLink, getMaxFileMB, ALLOWED_READ_EXTENSIONS } = require('./read-file');

const FETCH_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;

// Node's built-in fetch (package.json pins node >= 22, where it is always present).
// Checked here so a stripped-down runtime gets a plain sentence, not a crash.
function fetchImpl() {
  if (typeof globalThis.fetch !== 'function') throw linkError('this Node.js has no built-in web download (Node 22 or later is needed)');
  return globalThis.fetch;
}

// A link may be typed or handed over by an AI agent, so it is not allowed to reach
// this computer or the private network it sits on (loopback, private ranges, link-local
// including cloud metadata addresses, unique-local IPv6). Every redirect hop is checked
// the same way. XFA_ALLOW_PRIVATE_LINKS=1 lifts this for someone who means it.
// Residual, named: the name is resolved here and again by fetch, so a host that changes
// its DNS answer between the two (rebinding) is not caught.
const PRIVATE = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) {
  PRIVATE.addSubnet(a, bits, 'ipv4');
}
for (const [a, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, bits, 'ipv6');

function isPrivateAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  const family = net.isIP(ip);
  if (!family) return true;
  return PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublicHost(url, signal) {
  if (process.env.XFA_ALLOW_PRIVATE_LINKS === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const refuse = () => linkError('it points to this computer or a private network address, which is not opened');
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) throw refuse();
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    addrs = await withRetry(async () => {
      try { return (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address); } catch (_) {
        throw transient(linkError('the address could not be reached'));
      }
    }, signal);
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw refuse();
}

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

// A failed name lookup, a dropped connection or a 502/503/504 is tried again, at
// most RETRY_DELAYS_MS.length more times, all inside the one overall timeout.
const RETRY_DELAYS_MS = [300, 1000];
function transient(err) { err.transient = true; return err; }
async function withRetry(fn, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!e || !e.transient || attempt >= RETRY_DELAYS_MS.length || (signal && signal.aborted)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      if (signal && signal.aborted) throw linkError('the download took too long');
    }
  }
}

async function fetchOnce(url, signal) {
  let res;
  try {
    res = await fetchImpl()(url, { redirect: 'manual', signal, headers: { 'user-agent': 'xlsx-for-ai' } });
  } catch (e) {
    if (e && e.name === 'AbortError') throw linkError('the download took too long');
    throw transient(linkError('the address could not be reached'));
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    try { await res.body?.cancel(); } catch (_) { /* nothing to drain */ }
    throw transient(linkError(`the site answered ${res.status}`));
  }
  return res;
}

async function fetchWithRedirects(url, signal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current, signal);
    const res = await withRetry(() => fetchOnce(current, signal), signal);
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
// The bytes go straight to the temp file through a counter, so memory stays small
// whatever the size. The cap is the link's own type limit when its address names
// a type, else the largest limit; once the bytes show the type, its limit applies.
async function downloadLink(link) {
  const target = downloadUrlFor(link);
  const capMB = target.ext ? getMaxFileMB(target.ext) : getMaxFileMB();
  const capBytes = capMB * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-link-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } };
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

    const partial = path.join(dir, 'download.part');
    let total = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > capBytes) { cb(tooLarge(total, capMB)); return; }
        cb(null, chunk);
      },
    });
    try {
      const body = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
      await pipeline(body, counter, fs.createWriteStream(partial, { mode: 0o600 }));
    } catch (e) {
      controller.abort();
      if (e && e.code === 'FILE_TOO_LARGE') throw e;
      if (e && e.name === 'AbortError') throw linkError('the download took too long');
      throw linkError('the download was cut off');
    }
    if (total === 0) throw linkError('the link returned an empty file');

    const head = readHead(partial, 512);
    const ext = sniffExtension(head, target.ext, res.headers.get('content-type'));
    if (!ext) throw linkError('the link returned a web page, not a spreadsheet', 'LINK_NOT_SPREADSHEET');
    const typeCapMB = getMaxFileMB(ext);
    if (total > typeCapMB * 1024 * 1024) throw tooLarge(total, typeCapMB);

    const file = path.join(dir, `download${ext}`);
    fs.renameSync(partial, file);
    return { path: file, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
  } finally {
    fs.closeSync(fd);
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

module.exports = { downloadLink, downloadUrlFor, sniffExtension, linkFailedSentence, looksLikeLink, isPrivateAddress, LINK_NEXT_STEP };
