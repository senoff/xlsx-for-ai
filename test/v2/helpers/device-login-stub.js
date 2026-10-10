'use strict';

/**
 * Local stand-in for the hosted sign-in service and tool API, for tests and
 * smoke runs. Never talks to the real service.
 *
 *   /oauth/reg, /oauth/device/auth, /oauth/token, /api/v1/clients  device login
 *   /api/v1/tools/<name>   200 with a text result when the stored key is sent, else 401
 *   POST /__approve        the next token poll succeeds
 *   POST /__expire         the pending code reports expired_token
 *   POST /__config         JSON merged into state.cfg:
 *                            declineOnApprove  approval answers access_denied
 *                            clientsStatus     /api/v1/clients answers this status
 *                            toolResponse      {status, body} for a signed-in tool call
 *   GET  /__stats          counters and the user codes handed out
 */

const http = require('node:http');

const API_KEY = 'xfa_stub_key';

function startStub() {
  const state = {
    deviceRequests: 0,
    regCalls: 0,
    clientsCalls: 0,
    authCalls: 0,
    codes: [],
    approved: false,
    expired: false,
    tokenPolls: 0,
    toolCalls: [],
    unauthorizedToolCalls: 0,
    // POST /__config merges into this: declineOnApprove, clientsStatus, toolResponse.
    cfg: {},
  };
  let port;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };

      if (req.url === '/__approve') { state.approved = true; return send(200, {}); }
      if (req.url === '/__expire') { state.expired = true; return send(200, {}); }
      if (req.url === '/__stats') return send(200, state);
      if (req.url === '/__config') {
        try { Object.assign(state.cfg, JSON.parse(body || '{}')); } catch (_) { /* ignore */ }
        return send(200, state.cfg);
      }

      if (req.url === '/oauth/reg') {
        state.regCalls += 1;
        if (state.regCalls <= (state.cfg.regFailTimes || 0)) return send(503, {});
        return send(201, { client_id: 'stub-device-client' });
      }
      if (req.url === '/oauth/device/auth') {
        state.authCalls += 1;
        if (state.authCalls <= (state.cfg.authFailTimes || 0)) return send(503, {});
        if (state.cfg.authDelayMs) {
          // Slow answer, so two commands started together overlap here.
          return setTimeout(() => issueCode(), state.cfg.authDelayMs);
        }
        return issueCode();
      }
      function issueCode() {
        state.deviceRequests += 1;
        state.approved = false;
        state.expired = false;
        const code = `STUB-${String(state.deviceRequests).padStart(4, '0')}`;
        state.codes.push(code);
        return send(200, {
          device_code: `DEV-${code}`,
          user_code: code,
          expires_in: 900,
          interval: 1,
          verification_uri: `http://127.0.0.1:${port}/oauth/device`,
          verification_uri_complete: `http://127.0.0.1:${port}/oauth/device?user_code=${code}`,
        });
      }
      if (req.url === '/oauth/token') {
        state.tokenPolls += 1;
        if (state.expired) return send(400, { error: 'expired_token' });
        if (!state.approved) return send(400, { error: 'authorization_pending' });
        if (state.cfg.declineOnApprove) return send(400, { error: 'access_denied' });
        return send(200, { access_token: 'AT.stub.value', token_type: 'Bearer' });
      }
      if (req.url === '/api/v1/clients') {
        state.clientsCalls += 1;
        if (req.headers.authorization !== 'Bearer AT.stub.value') return send(401, {});
        if (state.cfg.clientsStatus) return send(state.cfg.clientsStatus, { error: { message: 'stub: cannot issue a key' } });
        return send(201, { client_id: 'stub-client-1', api_key: API_KEY });
      }
      if (req.url.startsWith('/api/v1/tools/') && req.url !== '/api/v1/tools/list') {
        if (req.headers.authorization !== `Bearer ${API_KEY}`) {
          state.unauthorizedToolCalls += 1;
          return send(401, { error: { code: 'unauthorized', message: 'Invalid or missing API key' } });
        }
        // Scripted answer for a signed-in call: { status, body } (402, 429, 501, ...).
        if (state.cfg.toolResponse) {
          state.toolCalls.push(req.url);
          return send(state.cfg.toolResponse.status, state.cfg.toolResponse.body);
        }
        state.toolCalls.push(req.url);
        return send(200, { content: [{ type: 'text', text: 'STUB TOOL RESULT: sheets = [Sheet1]' }] });
      }
      return send(404, {});
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startStub, API_KEY };
