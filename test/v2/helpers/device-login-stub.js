'use strict';

/**
 * Local stand-in for the hosted sign-in service and tool API, for tests and
 * smoke runs. Never talks to the real service.
 *
 *   /oauth/reg, /oauth/device/auth, /oauth/token, /api/v1/clients  device login
 *   /api/v1/tools/<name>   200 with a text result when the stored key is sent, else 401
 *   /api/v1/tools/list     the catalog in cfg.catalog (a list of tools), else 404
 *   POST /__approve        the next token poll succeeds
 *   POST /__expire         the pending code reports expired_token
 *   POST /__config         JSON merged into state.cfg:
 *                            declineOnApprove  approval answers access_denied
 *                            clientsStatus     /api/v1/clients answers this status
 *                            regStatus         /oauth/reg answers this status (e.g. 403)
 *                            toolResponse      {status, body} for a signed-in tool call
 *                            toolHeaders       headers added to every signed-in tool answer
 *                            catalog           tools answered by /api/v1/tools/list
 *                            distinctKeys      each key issued is different (xfa_stub_key,
 *                                              xfa_stub_key_2, ...) and every one works
 *                            clientsDelayMsByCall  [ms, ms, ...] pause before answering the
 *                                              1st, 2nd, ... /api/v1/clients call
 *   GET  /__stats          counters, the user codes handed out, the tool bodies received
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
    toolBodies: [],
    catalogFetches: 0,
    issuedKeys: [],
    unauthorizedToolCalls: 0,
    // POST /__config merges into this (see the list above).
    cfg: {},
  };
  let port;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const send = (status, obj, headers) => {
        res.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
        res.end(JSON.stringify(obj));
      };
      const keyOk = (auth) => auth === `Bearer ${API_KEY}`
        || (state.cfg.distinctKeys && state.issuedKeys.some((k) => auth === `Bearer ${k}`));

      if (req.url === '/__approve') { state.approved = true; return send(200, {}); }
      if (req.url === '/__expire') { state.expired = true; return send(200, {}); }
      if (req.url === '/__stats') return send(200, state);
      if (req.url === '/__config') {
        try { Object.assign(state.cfg, JSON.parse(body || '{}')); } catch (_) { /* ignore */ }
        return send(200, state.cfg);
      }

      if (req.url === '/oauth/reg') {
        state.regCalls += 1;
        if (state.cfg.regStatus) return send(state.cfg.regStatus, { error: 'invalid_client_metadata' });
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
        const call = state.clientsCalls;
        if (req.headers.authorization !== 'Bearer AT.stub.value') return send(401, {});
        if (state.cfg.clientsStatus) return send(state.cfg.clientsStatus, { error: { message: 'stub: cannot issue a key' } });
        const key = state.cfg.distinctKeys && call > 1 ? `${API_KEY}_${call}` : API_KEY;
        const answer = () => {
          state.issuedKeys.push(key);
          return send(201, { client_id: 'stub-client-1', api_key: key });
        };
        const delay = (state.cfg.clientsDelayMsByCall || [])[call - 1];
        return delay ? setTimeout(answer, delay) : answer();
      }
      if (req.url === '/api/v1/tools/list') {
        state.catalogFetches += 1;
        if (Array.isArray(state.cfg.catalog)) return send(200, { tools: state.cfg.catalog });
        return send(404, {});
      }
      if (req.url.startsWith('/api/v1/tools/')) {
        if (!keyOk(req.headers.authorization)) {
          state.unauthorizedToolCalls += 1;
          return send(401, { error: { code: 'unauthorized', message: 'Invalid or missing API key' } });
        }
        state.toolCalls.push(req.url);
        try { state.toolBodies.push(JSON.parse(body || '{}')); } catch (_) { state.toolBodies.push(null); }
        const headers = state.cfg.toolHeaders || {};
        // Scripted answer for a signed-in call: { status, body } (402, 429, 501, ...).
        if (state.cfg.toolResponse) {
          return send(state.cfg.toolResponse.status, state.cfg.toolResponse.body, headers);
        }
        return send(200, { content: [{ type: 'text', text: 'STUB TOOL RESULT: sheets = [Sheet1]' }] }, headers);
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
