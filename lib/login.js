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
const { readConfig, mergeConfig } = require('./config');
const { version } = require('../package.json');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function platform() {
  return `${process.platform}-${process.arch}`;
}

function oauthBase() {
  return `${apiBase()}/oauth`;
}

async function form(path, params) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Client-Version': version },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { status: res.status, body: body || {} };
}

async function ensureDeviceClient() {
  const cfg = readConfig() || {};
  if (cfg.oauth_device_client_id) return cfg.oauth_device_client_id;
  const res = await fetch(`${oauthBase()}/reg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'xlsx-for-ai-cli',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
      response_types: [],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    const e = new Error(`login: could not register the CLI with the sign-in service (HTTP ${res.status})`);
    e.code = 'LOGIN_FAILED';
    throw e;
  }
  mergeConfig({ oauth_device_client_id: body.client_id });
  return body.client_id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the device flow and persist an API key. `out` is a function(string) used
 * for user-facing prompts (stderr by default; stdout is reserved for tool output).
 * `opts.sleep` / `opts.now` are test seams.
 */
async function deviceLogin(opts = {}) {
  const out = opts.out || ((s) => process.stderr.write(s + '\n'));
  const doSleep = opts.sleep || sleep;
  const now = opts.now || Date.now;

  const clientId = await ensureDeviceClient();
  const resource = `${apiBase()}/mcp`;
  const auth = await form('/oauth/device/auth', {
    client_id: clientId, scope: 'openid offline_access', resource,
  });
  if (auth.status !== 200 || !auth.body.device_code) {
    const e = new Error(`login: the sign-in service refused the request (HTTP ${auth.status})`);
    e.code = 'LOGIN_FAILED';
    throw e;
  }
  const d = auth.body;
  out('To sign in to xlsx-for-ai, open this page in a browser:');
  out(`  ${d.verification_uri_complete || d.verification_uri}`);
  if (!d.verification_uri_complete) out(`and enter the code: ${d.user_code}`);
  else out(`(code: ${d.user_code})`);
  out('Waiting for you to approve...');

  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = now() + (Number(d.expires_in) || 900) * 1000;
  let accessToken = null;
  while (now() < deadline) {
    await doSleep(interval);
    const t = await form('/oauth/token', {
      grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: clientId,
      // The AS only mints a JWT access token (the form the API validates) when the
      // resource is named on the token request as well as on device/auth.
      resource,
    });
    if (t.status === 200 && t.body.access_token) { accessToken = t.body.access_token; break; }
    const err = t.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    const e = new Error(err === 'access_denied'
      ? 'login: sign-in was declined.'
      : err === 'expired_token' ? 'login: the code expired. Run `xlsx-for-ai login` again.'
      : `login: sign-in failed (${err || 'HTTP ' + t.status}).`);
    e.code = 'LOGIN_FAILED';
    throw e;
  }
  if (!accessToken) {
    const e = new Error('login: timed out waiting for approval. Run `xlsx-for-ai login` again.');
    e.code = 'LOGIN_FAILED';
    throw e;
  }

  const res = await fetch(`${apiBase()}/api/v1/clients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Version': version,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ client_version: version, platform: platform() }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.api_key) {
    const e = new Error(`login: signed in, but the key could not be issued (HTTP ${res.status}).`);
    e.code = 'LOGIN_FAILED';
    throw e;
  }
  mergeConfig({
    client_id: data.client_id,
    api_key: data.api_key,
    registered_at: new Date().toISOString(),
  });
  out('Signed in. You are ready to go.');
  return { client_id: data.client_id, api_key: data.api_key };
}

module.exports = { deviceLogin };
