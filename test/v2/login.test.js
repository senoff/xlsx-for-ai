'use strict';

/**
 * Sign-in behaviour of lib/register.js ensureRegistered() and the device flow
 * in lib/login.js. Three first-run cases:
 *   1. stored (older-version, anonymous) key  -> used as-is, no network
 *   2. no key, interactive terminal           -> OAuth device login, key stored
 *   3. no key, no terminal                    -> link + code on stderr, short wait, "run again" (XLS-3001)
 *      no key, XFA_NONINTERACTIVE=1           -> LOGIN_REQUIRED fast, no network, no anonymous mint
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let server, port, tmpDir, hits;
let tokenPolls;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/reg') { res.statusCode = 201; return res.end(JSON.stringify({ client_id: 'dev-client-1' })); }
        if (req.url === '/oauth/device/auth') {
          return res.end(JSON.stringify({
            device_code: 'DEVCODE', user_code: 'ABCD-EFGH', expires_in: 900, interval: 1,
            verification_uri: `http://127.0.0.1:${port}/oauth/device`,
            verification_uri_complete: `http://127.0.0.1:${port}/oauth/device?user_code=ABCD-EFGH`,
          }));
        }
        if (req.url === '/oauth/token') {
          tokenPolls += 1;
          if (!/resource=/.test(body)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_target' })); }
          if (tokenPolls < 2) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'authorization_pending' })); }
          return res.end(JSON.stringify({ access_token: 'AT.jwt.value', token_type: 'Bearer' }));
        }
        if (req.url === '/api/v1/clients') {
          if (req.headers.authorization !== 'Bearer AT.jwt.value') { res.statusCode = 401; return res.end('{}'); }
          res.statusCode = 201;
          return res.end(JSON.stringify({ client_id: 'oauth-client-9', api_key: 'xfa_oauth_key' }));
        }
        res.statusCode = 404; res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

const saved = {};
before(async () => {
  await startServer();
  for (const k of ['CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XLSX_FOR_AI_API', 'XFA_CONFIG_DIR', 'XFA_NONINTERACTIVE']) saved[k] = process.env[k];
  delete process.env.CI; delete process.env.GITHUB_ACTIONS; delete process.env.XLSX_FOR_AI_CI;
  process.env.XLSX_FOR_AI_API = `http://127.0.0.1:${port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  hits = []; tokenPolls = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-login-'));
  process.env.XFA_CONFIG_DIR = tmpDir;
  delete process.env.XFA_NONINTERACTIVE;
});

function fresh(mod) {
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k];
  return require(mod);
}
function setTty(v) {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
}

test('stored anonymous key from an older version keeps working, no network call', async () => {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ client_id: 'old-1', api_key: 'xfa_old_anon' }));
  setTty(false);
  const { ensureRegistered } = fresh('../../lib/register');
  const r = await ensureRegistered();
  assert.equal(r.api_key, 'xfa_old_anon');
  assert.equal(hits.length, 0);
});

test('B2-3: no key + no terminal (not an automated run): shows the link and code, never a dead end, no anonymous mint', async () => {
  setTty(false);
  process.env.XFA_LOGIN_WAIT_SECONDS = '0'; // one look at the approval, then "not yet"
  const origWrite = process.stderr.write;
  let shown = '';
  process.stderr.write = (s) => { shown += s; return true; };
  try {
    const { ensureRegistered } = fresh('../../lib/register');
    await assert.rejects(ensureRegistered(), (e) => {
      assert.equal(e.code, 'LOGIN_PENDING', 'waiting for the person, not LOGIN_REQUIRED');
      assert.match(e.message, /ABCD-EFGH/);
      assert.match(e.message, /run the same command again/);
      assert.doesNotMatch(e.message, /terminal/i);
      return true;
    });
  } finally {
    process.stderr.write = origWrite;
    delete process.env.XFA_LOGIN_WAIT_SECONDS;
  }
  assert.match(shown, /oauth\/device\?user_code=ABCD-EFGH/, 'link printed on stderr');
  assert.equal(hits.filter((h) => h.url === '/api/v1/clients').length, 0, 'no anonymous mint');
  assert.ok(hits.some((h) => h.url === '/oauth/device/auth'), 'a device request was made');
});

test('XFA_NONINTERACTIVE=1 forces the non-interactive error even on a TTY: fail fast, no network', async () => {
  setTty(true);
  process.env.XFA_NONINTERACTIVE = '1';
  const { ensureRegistered } = fresh('../../lib/register');
  await assert.rejects(ensureRegistered(), { code: 'LOGIN_REQUIRED' });
  setTty(false);
  assert.equal(hits.length, 0);
});

test('no key + interactive: device flow prints the URL, polls, stores an OAuth-bound key', async () => {
  setTty(true);
  const lines = [];
  const { deviceLogin } = fresh('../../lib/login');
  const { readConfig } = fresh('../../lib/config');
  const r = await deviceLogin({ out: (s) => lines.push(s), sleep: async () => {} });
  setTty(false);
  assert.equal(r.api_key, 'xfa_oauth_key');
  assert.equal(readConfig().api_key, 'xfa_oauth_key');
  assert.ok(lines.join('\n').includes('/oauth/device?user_code=ABCD-EFGH'), 'verification URL printed');
  const auth = hits.find((h) => h.url === '/oauth/device/auth');
  assert.match(auth.body, /resource=/);
  assert.ok(tokenPolls >= 2, 'polled through authorization_pending');
  const reg = hits.find((h) => h.url === '/api/v1/clients');
  assert.equal(reg.headers.authorization, 'Bearer AT.jwt.value');
});

test('ensureRegistered on a TTY with no key runs the device login (real 1s poll interval)', async () => {
  setTty(true);
  const origWrite = process.stderr.write;
  process.stderr.write = () => true; // silence the prompt text
  let r;
  try {
    const { ensureRegistered } = fresh('../../lib/register');
    r = await ensureRegistered();
  } finally {
    process.stderr.write = origWrite;
    setTty(false);
  }
  assert.equal(r.api_key, 'xfa_oauth_key');
});

test('device client id is cached per API origin, not shared across origins', async () => {
  const { deviceLogin } = fresh('../../lib/login');
  const { readConfig } = fresh('../../lib/config');
  await deviceLogin({ out: () => {}, sleep: async () => {} });
  const ids = readConfig().oauth_device_client_ids;
  assert.deepEqual(Object.keys(ids), ['http://127.0.0.1:' + port]);
  // a different origin must not reuse the cached id: it registers again (and here fails: nothing listens)
  process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:1';
  const again = fresh('../../lib/login');
  try {
    await assert.rejects(again.deviceLogin({ out: () => {}, sleep: async () => {} }), { code: 'LOGIN_FAILED' });
  } finally {
    process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:' + port;
  }
});

test('network failure during sign-in is a LOGIN_FAILED error, not a raw TypeError', async () => {
  process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:1';
  try {
    const { deviceLogin } = fresh('../../lib/login');
    await assert.rejects(deviceLogin({ out: () => {}, sleep: async () => {} }), (e) => {
      assert.equal(e.code, 'LOGIN_FAILED');
      assert.match(e.message, /could not reach/);
      return true;
    });
  } finally {
    process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:' + port;
  }
});

test('a transient 503 while polling does not abort the sign-in', async () => {
  const orig = server.listeners('request')[0];
  let fired = false;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/oauth/token' && !fired) { fired = true; res.statusCode = 503; return res.end('{}'); }
    orig(req, res);
  });
  try {
    const { deviceLogin } = fresh('../../lib/login');
    const r = await deviceLogin({ out: () => {}, sleep: async () => {} });
    assert.equal(r.api_key, 'xfa_oauth_key');
    assert.equal(fired, true);
  } finally {
    server.removeAllListeners('request');
    server.on('request', orig);
  }
});
