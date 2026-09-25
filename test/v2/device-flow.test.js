'use strict';

/**
 * XLS-1768 — CLI device-flow registration (RFC 8628 client half).
 *
 * Boots an in-process mock of the hosted API in its OAuth-REQUIRED mode (server
 * flag REQUIRE_OAUTH_CLIENT_REGISTRATION ON): POST /api/v1/clients 401s without a
 * bearer. Proves the flag-agnostic fallback in register.js:
 *   - anonymous POST /api/v1/clients → 401 ⇒ CLI runs device flow
 *     (DCR → /oauth/device/auth → poll /oauth/token through authorization_pending
 *      → access_token) ⇒ retries /api/v1/clients WITH the bearer ⇒ durable api_key
 *     stored in config.
 *   - and the back-compat case: when the server still allows anonymous
 *     registration (201 with no bearer), the device flow is NEVER triggered.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MOCK_CLIENT_ID = 'oauth-bound-client';
const MOCK_API_KEY = 'xfa_durable_key_from_oauth';
const DEVICE_CLIENT_ID = 'device-dcr-client';
const ACCESS_TOKEN = 'access-token-xyz';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

let server;
let serverPort;
let hits; // records which endpoints were called
let requireOauth; // toggles the mock between OAuth-required and anonymous modes
let tokenPollCount; // authorization_pending on the first poll, success after

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function startMockServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      res.setHeader('Content-Type', 'application/json');
      const auth = req.headers['authorization'];

      // Client registration — OAuth-gated when requireOauth.
      if (req.url === '/api/v1/clients' && req.method === 'POST') {
        hits.clients = (hits.clients || 0) + 1;
        if (requireOauth && !(auth && /^Bearer /i.test(auth))) {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="http://x/.well-known"');
          res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'OAuth required' } }));
          return;
        }
        if (requireOauth) hits.clientsBearer = auth;
        res.statusCode = 201;
        res.end(JSON.stringify({ client_id: MOCK_CLIENT_ID, api_key: MOCK_API_KEY }));
        return;
      }

      // DCR — register the device client.
      if (req.url === '/oauth/reg' && req.method === 'POST') {
        hits.reg = (hits.reg || 0) + 1;
        res.statusCode = 201;
        res.end(JSON.stringify({ client_id: DEVICE_CLIENT_ID }));
        return;
      }

      // Device authorization request.
      if (req.url === '/oauth/device/auth' && req.method === 'POST') {
        hits.deviceAuth = (hits.deviceAuth || 0) + 1;
        hits.deviceAuthBody = raw;
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            device_code: 'dev-code-123',
            user_code: 'WDJB-MJHT',
            verification_uri: 'http://x/oauth/device',
            verification_uri_complete: 'http://x/oauth/device?user_code=WDJB-MJHT',
            expires_in: 900,
            interval: 0,
          }),
        );
        return;
      }

      // Token polling — pending on the first poll, success on the second.
      if (req.url === '/oauth/token' && req.method === 'POST') {
        tokenPollCount += 1;
        hits.tokenPolls = tokenPollCount;
        const params = new URLSearchParams(raw);
        assert.equal(params.get('grant_type'), DEVICE_GRANT);
        assert.equal(params.get('device_code'), 'dev-code-123');
        if (tokenPollCount < 2) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'authorization_pending' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 600 }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

let tmpDir;
const originalCi = process.env.CI;
const originalGha = process.env.GITHUB_ACTIONS;
const originalXfaCi = process.env.XLSX_FOR_AI_CI;

before(async () => {
  await startMockServer();
  process.env.XLSX_FOR_AI_API = `http://127.0.0.1:${serverPort}`;
  process.env.XFA_DEVICE_POLL_INTERVAL_MS = '5'; // fast, deterministic polling
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.XLSX_FOR_AI_CI;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.XLSX_FOR_AI_API;
  delete process.env.XFA_DEVICE_POLL_INTERVAL_MS;
  if (originalCi !== undefined) process.env.CI = originalCi;
  if (originalGha !== undefined) process.env.GITHUB_ACTIONS = originalGha;
  if (originalXfaCi !== undefined) process.env.XLSX_FOR_AI_CI = originalXfaCi;
});

beforeEach(() => {
  hits = {};
  tokenPollCount = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-devflow-'));
  process.env.XFA_CONFIG_DIR = tmpDir;
});

function freshRequire(mod) {
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('xlsx-for-ai-wt-1768/lib/') || k.includes('/lib/')) delete require.cache[k];
  });
  return require(mod);
}

test('flag ON: 401 triggers device flow, then registration retries with the bearer and stores the durable key', async () => {
  requireOauth = true;
  const { ensureRegistered } = freshRequire('../../lib/register');
  const { readConfig } = freshRequire('../../lib/config');

  const result = await ensureRegistered();

  assert.equal(result.client_id, MOCK_CLIENT_ID);
  assert.equal(result.api_key, MOCK_API_KEY);

  // The full device-flow round trip ran.
  assert.equal(hits.reg, 1, 'DCR registered a device client');
  assert.equal(hits.deviceAuth, 1, 'requested a device code');
  assert.ok(hits.tokenPolls >= 2, 'polled through authorization_pending to success');
  // /api/v1/clients was hit twice: the anonymous 401, then the bearer retry.
  assert.equal(hits.clients, 2);
  assert.equal(hits.clientsBearer, `Bearer ${ACCESS_TOKEN}`, 'retry carried the device-flow bearer');
  // device/auth requested the canonical resource so aud is right.
  assert.match(new URLSearchParams(hits.deviceAuthBody).get('resource'), /\/mcp$/);

  const cfg = readConfig();
  assert.equal(cfg.api_key, MOCK_API_KEY);
  assert.equal(cfg.client_id, MOCK_CLIENT_ID);
  assert.ok(cfg.registered_at);
});

test('flag OFF (back-compat): anonymous 201 registers directly, device flow never runs', async () => {
  requireOauth = false;
  const { ensureRegistered } = freshRequire('../../lib/register');

  const result = await ensureRegistered();

  assert.equal(result.api_key, MOCK_API_KEY);
  assert.equal(hits.clients, 1, 'single anonymous registration call');
  assert.equal(hits.reg, undefined, 'no DCR');
  assert.equal(hits.deviceAuth, undefined, 'no device authorization');
  assert.equal(tokenPollCount, 0, 'no token polling');
});

test('device flow surfaces a terminal OAuth error (access_denied) instead of hanging', async () => {
  // A token endpoint that returns access_denied — pollForToken must reject with a
  // terminal code, never loop until the deadline.
  const denyServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'access_denied' }));
  });
  await new Promise((r) => denyServer.listen(0, '127.0.0.1', r));
  const denyPort = denyServer.address().port;
  const prevApi = process.env.XLSX_FOR_AI_API;
  process.env.XLSX_FOR_AI_API = `http://127.0.0.1:${denyPort}`;
  const { pollForToken } = freshRequire('../../lib/device-flow');
  try {
    await assert.rejects(
      () => pollForToken('cid', 'dev-code', 0, 60),
      (err) => err && err.code === 'DEVICE_AUTH_INCOMPLETE',
    );
  } finally {
    process.env.XLSX_FOR_AI_API = prevApi;
    await new Promise((r) => denyServer.close(r));
  }
});
