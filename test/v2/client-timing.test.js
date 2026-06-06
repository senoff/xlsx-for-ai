'use strict';

// Regression test for SPM P1 2026-06-06
// (xlsx-hosted-tool-latency-timeout).
//
// 3.0.7 tightens the per-attempt timeout from 30s → 15s, bumps retries
// from 1 → 2 (3 attempts, 45s ceiling), and emits structured timing logs
// to stderr per phase. The timing log is the next-occurrence diagnostic:
// when this happens again we'll see whether the latency is in the dial,
// the response-headers, or the body-complete phase.
//
// These tests assert the observable contract — failing the test catches
// a future refactor that drops the stderr signal SPM/Bob rely on for
// triage.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLIENT_PATH = path.join(__dirname, '..', '..', 'lib', 'client.js');

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function freshClient() {
  // Strip cached `require('./lib/client.js')` so timing constants reset
  // between tests (TIMEOUT_MS / MAX_ATTEMPTS are module-level).
  delete require.cache[CLIENT_PATH];
  delete require.cache[require.resolve('../../lib/config')];
  return require('../../lib/client.js');
}

test('emitTiming writes one-line JSON to stderr per phase (send + body-complete on happy path)', async () => {
  const { server, port } = await startTestServer((req, res) => {
    if (req.url === '/api/v1/tools/xlsx_test') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Capture stderr from a clean Node subprocess so we don't pollute the
  // test runner's stream.
  const child = spawn('node', [
    '-e',
    `
      process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:${port}';
      process.env.XFA_CONFIG_DIR = '${fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-timing-'))}';
      const { callTool } = require('${CLIENT_PATH}');
      callTool('xlsx_test', { hello: 'world' })
        .then(() => process.exit(0))
        .catch((e) => {
          process.stderr.write('CAUGHT: ' + e.message + '\\n');
          process.exit(1);
        });
    `,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      server.close();
      if (code !== 0) reject(new Error(`subprocess exited ${code}: ${stderr}`));
      else resolve();
    });
  });

  const lines = stderr.split('\n').filter(Boolean);
  const events = lines
    .map((ln) => { try { return JSON.parse(ln); } catch { return null; } })
    .filter((e) => e && e.t === 'xlsx-for-ai-mcp.timing');

  // Expect at least the send + body-complete phases.
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('send'), `expected 'send' phase in: ${phases.join(',')}`);
  assert.ok(phases.includes('body-complete'), `expected 'body-complete' phase in: ${phases.join(',')}`);
  // The send event must record the body size so we can correlate request
  // shape with latency.
  const sendEvent = events.find((e) => e.phase === 'send');
  assert.equal(typeof sendEvent.body_bytes, 'number', 'send event must record body_bytes');
  assert.ok(sendEvent.body_bytes > 0);
  // The body-complete event must carry an elapsed_ms.
  const completeEvent = events.find((e) => e.phase === 'body-complete');
  assert.equal(typeof completeEvent.elapsed_ms, 'number');
  assert.ok(completeEvent.elapsed_ms >= 0);
  // The path field must identify the tool route so multi-tool sessions
  // remain decodable.
  assert.equal(sendEvent.path, '/api/v1/tools/xlsx_test');
  assert.equal(completeEvent.path, '/api/v1/tools/xlsx_test');
});

test('the per-attempt timeout has been tightened from 30s and retries bumped from 1', () => {
  // Source-level invariant — read the file and assert the constants.
  // Catches a refactor that silently raises the timeout back to the
  // pre-3.0.7 default.
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');
  const timeoutMatch = src.match(/const TIMEOUT_MS\s*=\s*(\d+(?:_\d+)?);/);
  const attemptsMatch = src.match(/const MAX_ATTEMPTS\s*=\s*(\d+);/);
  assert.ok(timeoutMatch, 'TIMEOUT_MS constant not found');
  assert.ok(attemptsMatch, 'MAX_ATTEMPTS constant not found');
  const timeoutMs = parseInt(timeoutMatch[1].replace(/_/g, ''), 10);
  const maxAttempts = parseInt(attemptsMatch[1], 10);
  // 15s upper bound: anything higher than 15s slipped past the SPM P1
  // tightening. Lower is fine.
  assert.ok(timeoutMs <= 15_000,
    `TIMEOUT_MS=${timeoutMs} exceeds 15s SPM-tightened ceiling`);
  // Need at least 2 retries to give the stuck-socket pattern a fresh
  // dispatcher to break through.
  assert.ok(maxAttempts >= 3,
    `MAX_ATTEMPTS=${maxAttempts} is below the 3-attempt minimum`);
});
