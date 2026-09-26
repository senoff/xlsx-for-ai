'use strict';

/**
 * RFC 8628 OAuth 2.0 Device Authorization Grant — client half (XLS-1768).
 *
 * The npm CLI runs in a terminal with no browser-redirect target, so it can't
 * use the authorization-code flow. Device flow is the standard answer (gh, gcloud,
 * az all use it): request a device_code + short user_code, print a verification
 * URL + code, the user authenticates in ANY browser, and we poll the token
 * endpoint until authorized.
 *
 * This runs ONLY when the hosted API requires OAuth for client registration — the
 * server-side flag REQUIRE_OAUTH_CLIENT_REGISTRATION (XLS-1768). register.js calls
 * it on a 401 from the anonymous POST /api/v1/clients, so the CLI adapts to
 * whichever mode the server is in WITHOUT a coordinated release (works before AND
 * after the flip).
 *
 * All progress goes to STDERR — stdout is the MCP JSON-RPC transport in the
 * mcp-server context and must never carry human-facing text.
 *
 * We do NOT persist the OAuth tokens: the access token is used once, to mint a
 * durable oauth-bound api_key via POST /api/v1/clients (the server binds the
 * plan + identity), and that api_key is what register.js stores for every
 * subsequent REST/tool call — the CLI's existing auth shape is unchanged.
 */

const { apiBase } = require('./client');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPE = 'mcp:tools';
// RFC 8628 §3.2: the client defaults to 5s when the server omits `interval`.
const DEFAULT_INTERVAL_S = 5;
// Hard ceiling so a device_code that is never authorized cannot poll forever —
// the server's device_code also expires (expires_in), whichever comes first.
const MAX_POLL_SECONDS = 900;
const FETCH_TIMEOUT_MS = 15_000;

function log(msg) {
  try {
    process.stderr.write(msg + '\n');
  } catch (_) {
    /* EPIPE on stderr: no-op, never break registration on a missing log sink */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** POST application/x-www-form-urlencoded to an /oauth endpoint; returns { status, body }. */
async function formPost(path, params) {
  const res = await fetchWithTimeout(apiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Register a public device-flow client via DCR (open registration). A native
 * client with ONLY the device_code grant, no client secret, no redirect_uris.
 * The server is a public-subject AS, so no pairwise constraints apply.
 */
async function registerDeviceClient() {
  const res = await fetchWithTimeout(apiBase() + '/oauth/reg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      application_type: 'native',
      client_name: 'xlsx-for-ai CLI',
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT],
      response_types: [],
    }),
  });
  if (res.status !== 201) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch (_) {
      detail = res.statusText;
    }
    const err = new Error(`device-flow client registration failed (${res.status}): ${detail}`);
    err.code = 'DEVICE_DCR_FAILED';
    throw err;
  }
  const body = await res.json();
  return body.client_id;
}

/** The RFC 8628 authorization request: get a device_code + user_code pair. */
async function requestDeviceCode(clientId) {
  const resource = `${apiBase()}/mcp`; // canonical resource → aud on the minted token
  const { status, body } = await formPost('/oauth/device/auth', {
    client_id: clientId,
    scope: SCOPE,
    resource,
  });
  if (status !== 200 || !body || !body.device_code) {
    const err = new Error(`device authorization request failed (${status})`);
    err.code = 'DEVICE_AUTH_FAILED';
    throw err;
  }
  return body;
}

/**
 * Poll the token endpoint until the user authorizes, per RFC 8628 §3.5:
 *  - authorization_pending → keep waiting at the current interval
 *  - slow_down            → increase the interval by 5s (spec-mandated)
 *  - access_denied / expired_token → terminal error
 *  - 200 with access_token → done
 */
async function pollForToken(clientId, deviceCode, intervalSeconds, expiresInSeconds) {
  let interval = intervalSeconds || DEFAULT_INTERVAL_S;
  const deadline = Date.now() + Math.min((expiresInSeconds || MAX_POLL_SECONDS) * 1000, MAX_POLL_SECONDS * 1000);
  // XFA_DEVICE_POLL_INTERVAL_MS overrides the wait between polls — a test seam
  // for deterministic fast runs, also usable by ops to tune polling. When set it
  // fixes the wait; otherwise the RFC 8628 interval (+ slow_down bumps) applies.
  const overrideMs = process.env.XFA_DEVICE_POLL_INTERVAL_MS
    ? Number(process.env.XFA_DEVICE_POLL_INTERVAL_MS)
    : null;

  while (Date.now() < deadline) {
    await sleep(overrideMs != null ? overrideMs : interval * 1000);
    const { status, body } = await formPost('/oauth/token', {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
    });
    if (status === 200 && body && body.access_token) {
      return body.access_token;
    }
    const error = body && body.error;
    if (error === 'authorization_pending') {
      continue;
    }
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    // access_denied, expired_token, or any other OAuth error is terminal.
    const err = new Error(`device authorization did not complete: ${error || `HTTP ${status}`}`);
    err.code = 'DEVICE_AUTH_INCOMPLETE';
    throw err;
  }
  const err = new Error('device authorization timed out before you approved it');
  err.code = 'DEVICE_AUTH_TIMEOUT';
  throw err;
}

/**
 * Full device-flow round trip → returns an OAuth access token. Prints the
 * verification instructions to stderr. Throws (with a `.code`) on any failure so
 * register.js can surface a clear message.
 */
async function obtainDeviceFlowToken() {
  const clientId = await registerDeviceClient();
  const auth = await requestDeviceCode(clientId);
  const uriComplete = auth.verification_uri_complete;
  log('');
  log('  xlsx-for-ai needs you to sign in to continue.');
  if (uriComplete) {
    log(`  Open:  ${uriComplete}`);
    log(`  (or go to ${auth.verification_uri} and enter code ${auth.user_code})`);
  } else {
    log(`  Open:  ${auth.verification_uri}`);
    log(`  Enter code:  ${auth.user_code}`);
  }
  log('  Waiting for you to approve…');
  log('');
  const token = await pollForToken(clientId, auth.device_code, auth.interval, auth.expires_in);
  log('  Signed in. Finishing setup…');
  return token;
}

module.exports = {
  obtainDeviceFlowToken,
  // exported for unit tests
  registerDeviceClient,
  requestDeviceCode,
  pollForToken,
};
