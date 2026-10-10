'use strict';

/**
 * `xlsx-for-ai login` — OAuth device authorization grant (RFC 8628).
 *
 *   1. Register a public device client (dynamic client registration, cached).
 *   2. POST /oauth/device/auth  -> user_code + verification URL.
 *   3. Print the URL + code, poll /oauth/token until approved.
 *   4. Exchange the access token for a durable API key at POST /api/v1/clients
 *      (Authorization: Bearer <access token>) and store it in the config.
 *
 * Every wait is bounded: the poll loop honours `interval`/`slow_down` and
 * gives up at the device code's `expires_in`. Nothing here ever reads stdin.
 */

const { apiBase } = require('./client');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readConfig, mergeConfig, configPath } = require('./config');

// A closed or broken stderr must not take a sign-in down with an exception.
function stderrLine(s) {
  try { process.stderr.write(s + '\n'); } catch (_) { /* nowhere to show it */ }
}
const { version } = require('../package.json');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function platform() {
  return `${process.platform}-${process.arch}`;
}

function oauthBase() {
  return `${apiBase()}/oauth`;
}

// fetch that turns a network-level failure (DNS, refused, timeout) into a
// LOGIN_FAILED error with a plain message instead of a raw TypeError.
async function safeFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const e = new Error('login: could not reach the sign-in service. Check your network connection and try again.');
    e.code = 'LOGIN_FAILED';
    e.reason = 'unreachable';
    e.cause = err;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Up to 3 tries (2 pauses) for a call that is safe to repeat: it creates nothing
// that matters twice. Retries on a network failure or a 5xx answer; any other
// answer (including 4xx) is final. Never used for the call that issues the key.
const RETRY_PAUSES_MS = [300, 900];
async function withRetry(call, answerIsTransient) {
  for (let i = 0; ; i += 1) {
    let result = null;
    let failure = null;
    try { result = await call(); } catch (err) { failure = err; }
    const again = failure
      ? Boolean(failure.code === 'LOGIN_FAILED' && failure.reason === 'unreachable')
      : answerIsTransient(result);
    if (!again || i >= RETRY_PAUSES_MS.length) {
      if (failure) throw failure;
      return result;
    }
    await sleep(RETRY_PAUSES_MS[i]);
  }
}
const isServerError = (r) => Number(r && r.status) >= 500;

async function form(path, params) {
  const res = await safeFetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Client-Version': version },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { status: res.status, body: body || {} };
}

// The device client id is registered per API origin, so it is cached per origin:
// switching XLSX_FOR_AI_API (staging, self-hosted) never reuses another issuer's id.
async function ensureDeviceClient() {
  const cfg = readConfig() || {};
  const origin = apiBase();
  const cached = cfg.oauth_device_client_ids && cfg.oauth_device_client_ids[origin];
  if (cached) return cached;
  // Registering a client is safe to repeat (a lookup that only ever yields an id).
  const res = await withRetry(() => safeFetch(`${oauthBase()}/reg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'xlsx-for-ai-cli',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
      response_types: [],
    }),
    signal: AbortSignal.timeout(15000),
  }), isServerError);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    const e = new Error(`login: could not register the CLI with the sign-in service (HTTP ${res.status}). Try again in a minute.`);
    e.code = 'LOGIN_FAILED';
    e.reason = 'unreachable';
    throw e;
  }
  // The cache is only a saving. If the config cannot be written, carry on: the
  // sign-in must still show its link, and the failure to save the key at the end
  // is reported on its own (reason: not_saved) instead of a vague error here.
  try {
    mergeConfig({ oauth_device_client_ids: { ...(cfg.oauth_device_client_ids || {}), [origin]: body.client_id } });
  } catch (_) {
    stderrLine(`xlsx-for-ai: could not remember the sign-in client in ${path.dirname(configPath())} (is the folder writable?). Sign-in goes on; it will ask the service again next time.`);
  }
  return body.client_id;
}

/**
 * Step 1 of the device flow: ask the sign-in service for a code. Prints nothing
 * and reads nothing, so the MCP server can call it too. Returns the request the
 * poll step needs plus the link and short code to show the user.
 */
async function startDeviceRequest() {
  const clientId = await ensureDeviceClient();
  const resource = `${apiBase()}/mcp`;
  // Asking for a code is safe to repeat: an unused code just expires.
  const auth = await withRetry(() => form('/oauth/device/auth', {
    client_id: clientId, scope: 'openid offline_access', resource,
  }), isServerError);
  if (auth.status !== 200 || !auth.body.device_code) {
    const e = new Error(`login: the sign-in service refused the request (HTTP ${auth.status}). Try again in a minute.`);
    e.code = 'LOGIN_FAILED';
    e.reason = 'unreachable';
    throw e;
  }
  const d = auth.body;
  return {
    clientId,
    resource,
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete: d.verification_uri_complete,
    interval: d.interval,
    expiresIn: d.expires_in,
  };
}

/**
 * Run the device flow and persist an API key. `out` is a function(string) used
 * for user-facing prompts (stderr by default; stdout is reserved for tool output).
 * `opts.sleep` / `opts.now` are test seams.
 */
async function deviceLogin(opts = {}) {
  const out = opts.out || stderrLine;
  const req = await startDeviceRequest();
  out('To sign in to xlsx-for-ai, open this page in a browser:');
  out(`  ${req.verificationUriComplete || req.verificationUri}`);
  if (!req.verificationUriComplete) out(`and enter the code: ${req.userCode}`);
  else out(`(code: ${req.userCode})`);
  out('Waiting for you to approve...');
  const result = await pollDeviceLogin(req, opts);
  out('Signed in. You are ready to go.');
  return result;
}

/**
 * Step 2 of the device flow: poll until the user approves, then exchange the
 * approval for a durable key and store it. Bounded by the code's expiry.
 * `opts.sleep` / `opts.now` are test seams.
 */
async function pollDeviceLogin(req, opts = {}) {
  const doSleep = opts.sleep || sleep;
  const now = opts.now || Date.now;
  const { clientId, resource } = req;
  const d = { device_code: req.deviceCode, interval: req.interval, expires_in: req.expiresIn };

  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = now() + (Number(d.expires_in) || 900) * 1000;
  let accessToken = null;
  // A transient failure while polling (network blip, 5xx) must not abort a sign-in
  // the user is mid-way through approving: keep polling, but give up after a run
  // of consecutive failures. The loop stays bounded by the device code's expiry.
  let transient = 0;
  // Optional shorter wait (a command run with no terminal): stop polling when the
  // next poll would land past the window, and report "not approved yet" so the
  // person can approve and run the same command again. `pollFirst` checks once
  // before the first sleep, so a request approved in the meantime finishes at once.
  const windowEnd = opts.maxWaitMs != null ? now() + Math.max(0, Number(opts.maxWaitMs)) : Infinity;
  let first = true;
  let windowHit = false;
  while (now() < deadline) {
    if (!(first && opts.pollFirst)) {
      if (now() + interval > windowEnd) { windowHit = true; break; }
      await doSleep(interval);
    }
    first = false;
    let t;
    try {
      t = await form('/oauth/token', {
        grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: clientId,
        // The AS only mints a JWT access token (the form the API validates) when the
        // resource is named on the token request as well as on device/auth.
        resource,
      });
    } catch (err) {
      if (err && err.code === 'LOGIN_FAILED' && ++transient < 5) continue;
      throw err;
    }
    if (t.status >= 500) {
      if (++transient < 5) continue;
      const e = new Error(`login: the sign-in service is having trouble (HTTP ${t.status}). Try again shortly.`);
      e.code = 'LOGIN_FAILED';
      e.reason = 'unreachable';
      throw e;
    }
    transient = 0;
    if (t.status === 200 && t.body.access_token) { accessToken = t.body.access_token; break; }
    const err = t.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    const e = new Error(err === 'access_denied'
      ? 'login: sign-in was declined.'
      : err === 'expired_token' ? 'login: the code expired. Run `xlsx-for-ai login` again.'
      : `login: sign-in failed (${err || 'HTTP ' + t.status}).`);
    e.code = 'LOGIN_FAILED';
    e.reason = err === 'access_denied' ? 'declined' : err === 'expired_token' ? 'expired' : 'failed';
    throw e;
  }
  if (!accessToken) {
    if (windowHit) {
      const e = new Error('login: not approved yet.');
      e.code = 'LOGIN_PENDING';
      throw e;
    }
    const e = new Error('login: timed out waiting for approval. Run `xlsx-for-ai login` again.');
    e.code = 'LOGIN_FAILED';
    e.reason = 'expired';
    throw e;
  }

  // DELIBERATELY NOT RETRIED: this call issues the key. If the first try reached
  // the service and only the answer was lost, a second try could mint a second
  // key. So a failure here ends the sign-in with a message saying exactly what
  // happened, and running the command again is safe (it starts a new sign-in).
  const NOT_ISSUED_NEXT = 'Nothing was saved. Running the same command again is safe: it starts a new sign-in.';
  let res;
  try {
    res = await safeFetch(`${apiBase()}/api/v1/clients`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Version': version,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ client_version: version, platform: platform() }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`login: you approved the sign-in, but the service could not be reached to create your key. ${NOT_ISSUED_NEXT}`);
    e.code = 'LOGIN_FAILED';
    e.reason = 'not_issued';
    e.cause = err;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.api_key) {
    const e = new Error(`login: you approved the sign-in, but the key could not be issued (HTTP ${res.status}). ${NOT_ISSUED_NEXT}`);
    e.code = 'LOGIN_FAILED';
    e.reason = 'not_issued';
    throw e;
  }
  try {
    mergeConfig({
      client_id: data.client_id,
      api_key: data.api_key,
      registered_at: new Date().toISOString(),
    });
  } catch (err) {
    const e = new Error('login: signed in, but the key could not be saved to the config file. Check that ~/.xlsx-for-ai is writable and try again.');
    e.code = 'LOGIN_FAILED';
    e.reason = 'not_saved';
    e.cause = err;
    throw e;
  }
  return { client_id: data.client_id, api_key: data.api_key };
}

// ---------------------------------------------------------------------------
// Sign-in for a command run with no terminal that is not an automated run (an
// assistant's shell tool, a pipe, an editor task). A person is behind it, so:
// show the link and code on stderr, wait a short while for approval, and if it
// has not come yet, say so and remember the request. Running the same command
// again resumes the SAME code and finishes at once if it was approved meanwhile.
// ---------------------------------------------------------------------------

const DEFAULT_SIGN_IN_WAIT_SECONDS = 60;

const MAX_SIGN_IN_WAIT_SECONDS = 900;

// XFA_LOGIN_WAIT_SECONDS: a number of seconds from 0 to 900. A value that is not
// a number, or is negative, falls back to the default; a larger one is capped.
// `note` (optional) gets one plain line saying so. The raw value is never echoed.
function signInWaitMs(note) {
  const raw = process.env.XFA_LOGIN_WAIT_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_SIGN_IN_WAIT_SECONDS * 1000;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    if (note) note(`xlsx-for-ai: XFA_LOGIN_WAIT_SECONDS is not a number of seconds from 0 to ${MAX_SIGN_IN_WAIT_SECONDS}, so ${DEFAULT_SIGN_IN_WAIT_SECONDS} seconds is used.`);
    return DEFAULT_SIGN_IN_WAIT_SECONDS * 1000;
  }
  if (n > MAX_SIGN_IN_WAIT_SECONDS) {
    if (note) note(`xlsx-for-ai: XFA_LOGIN_WAIT_SECONDS is above the limit, so ${MAX_SIGN_IN_WAIT_SECONDS} seconds is used.`);
    return MAX_SIGN_IN_WAIT_SECONDS * 1000;
  }
  return n * 1000;
}

// ---- the saved sign-in request ---------------------------------------------
// The request waiting for approval is kept in its own small file beside the
// config, never inside config.json, so saving or dropping it cannot touch the
// stored key or any other setting. Every operation is ONE file-system step on
// the whole file: save writes a private temp file and renames it into place,
// drop unlinks, load reads. Nothing is read, changed and written back, so two
// commands have nothing to interleave and there is no lock to hold, refresh or
// go stale.
//
// Two commands started together each ask for their own code and each waits on
// its own. The file holds whichever was saved last; both codes stay valid until
// they run out, and approving either one signs this computer in.
function pendingPath() {
  return path.join(path.dirname(configPath()), 'pending-login.json');
}

function readPendingFile() {
  try {
    const p = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    return p && typeof p === 'object' ? p : null;
  } catch (_) {
    return null; // none saved, or not readable: the caller starts a fresh request
  }
}

// A saved request for another service address, or one that is incomplete or out
// of time, is simply not used; the next save replaces it.
function loadPendingRequest() {
  const p = readPendingFile();
  if (!p || p.origin !== apiBase() || typeof p.deviceCode !== 'string' || !p.deviceCode
    || typeof p.clientId !== 'string' || !p.clientId || !(Number(p.expiresAtMs) > Date.now())) {
    return null;
  }
  return {
    clientId: p.clientId,
    resource: p.resource,
    deviceCode: p.deviceCode,
    userCode: p.userCode,
    verificationUri: p.verificationUri,
    verificationUriComplete: p.verificationUriComplete,
    interval: p.interval,
    expiresIn: Math.max(1, Math.round((Number(p.expiresAtMs) - Date.now()) / 1000)),
  };
}

// True when the request is on disk in full. A reader sees the old file or the
// new one, never a part-written one (rename within one folder is atomic).
function savePendingRequest(req) {
  const p = pendingPath();
  const tmp = `${p}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({
      origin: apiBase(),
      clientId: req.clientId,
      resource: req.resource,
      deviceCode: req.deviceCode,
      userCode: req.userCode,
      verificationUri: req.verificationUri,
      verificationUriComplete: req.verificationUriComplete,
      interval: req.interval,
      expiresAtMs: Date.now() + (Number(req.expiresIn) || 900) * 1000,
    }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* never created */ }
    return false;
  }
}

// Drop the saved request. With `req`, only if the file still holds that request:
// a newer one saved by another command is left for that command's rerun. (If the
// other command saves in the instant between the look and the unlink, its rerun
// shows a fresh code; nothing else is affected.)
function dropPendingRequest(req) {
  if (req) {
    const p = readPendingFile();
    if (!p || p.deviceCode !== req.deviceCode) return;
  }
  try { fs.unlinkSync(pendingPath()); } catch (_) { /* already gone */ }
}

// Ways a request can end for good: it must not be picked up by a rerun.
const FINAL_REASONS = new Set(['declined', 'expired', 'failed', 'not_issued', 'not_saved']);

async function deviceLoginWithWindow(opts = {}) {
  const out = opts.out || stderrLine;
  const waitMs = opts.waitMs != null ? opts.waitMs : signInWaitMs(out);
  let req = loadPendingRequest();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resumed = Boolean(req);
    if (!req) {
      req = await startDeviceRequest();
      // The request file and the key live in the same folder. If the request
      // cannot be saved there, the key could not be either, so stop now, before
      // the person approves something this computer cannot keep.
      if (!savePendingRequest(req)) {
        const e = new Error(`login: the sign-in could not be saved in ${path.dirname(configPath())}, so it was stopped before you were asked to approve anything. Make that folder writable (or set XFA_CONFIG_DIR to a folder that is), then run the same command again.`);
        e.code = 'LOGIN_FAILED';
        e.reason = 'unwritable';
        throw e;
      }
    }
    const link = req.verificationUriComplete || req.verificationUri;
    out('To sign in to xlsx-for-ai, open this page in a browser:');
    out(`  ${link}`);
    if (!req.verificationUriComplete) out(`and enter the code: ${req.userCode}`);
    else out(`(code: ${req.userCode})`);
    out(`Waiting up to ${Math.round(waitMs / 1000)} seconds for you to approve...`);
    try {
      const result = await pollDeviceLogin(req, { ...opts, maxWaitMs: waitMs, pollFirst: resumed });
      // The key is stored, so no saved request is of use to any command now.
      dropPendingRequest();
      out('Signed in. You are ready to go.');
      return result;
    } catch (err) {
      if (err && err.code === 'LOGIN_PENDING') {
        err.link = link;
        err.userCode = req.userCode;
        err.message = `sign-in is waiting for you. Open ${link} (code ${req.userCode}) and approve it, then run the same command again.`;
        throw err;
      }
      if (err && FINAL_REASONS.has(err.reason)) dropPendingRequest(req);
      // A saved request that had run out: start one fresh code in this same run.
      if (resumed && err && err.reason === 'expired') { req = null; continue; }
      throw err;
    }
  }
  throw new Error('login: could not start a sign-in.');
}

module.exports = { deviceLogin, deviceLoginWithWindow, startDeviceRequest, pollDeviceLogin, signInWaitMs };
