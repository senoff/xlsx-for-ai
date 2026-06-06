'use strict';

// Regression test for SPM P0 2026-06-05 (mcp-attach-hangs-builtin-node24).
//
// Under Claude Desktop's bundled Node 24.x runtime, the registration POST
// and the catalog GET can hang indefinitely (IPv6 / Happy-Eyeballs edge in
// Electron), and the client gives up at 60s. Fix: connect transport BEFORE
// any network round-trip. This test pins that invariant on the surface
// where it matters — initialize must respond fast even when XLSX_FOR_AI_API
// points at a TCP black hole.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MCP_PATH = path.join(__dirname, '..', '..', 'mcp.js');

// RFC 5737 TEST-NET-1; never routes. TCP connects against this hang until
// the kernel times out (well past our test bounds), which is exactly the
// hang condition the Claude Desktop / Node 24 bundle produces.
const BLACK_HOLE_API = 'https://192.0.2.1';

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

test('initialize responds in <2s even when the network is a black hole', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-init-test-'));
  const child = spawn('node', [MCP_PATH], {
    env: {
      ...process.env,
      XLSX_FOR_AI_API: BLACK_HOLE_API,
      XFA_CONFIG_DIR: tmpDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const t0 = Date.now();
  let initBuffer = '';
  let initResp = null;
  let resolved = false;

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      initBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = initBuffer.indexOf('\n')) >= 0) {
        const line = initBuffer.slice(0, idx);
        initBuffer = initBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id === 1 && obj.result) {
            initResp = { obj, latencyMs: Date.now() - t0 };
            resolved = true;
            resolve();
          }
        } catch (_) {}
      }
    });
    child.on('error', reject);
    setTimeout(() => {
      if (!resolved) reject(new Error('initialize did not respond within 2s'));
    }, 2000).unref();
  });

  child.stdin.write(rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  }));

  try {
    await done;
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  assert.ok(initResp, 'initialize must respond');
  assert.ok(
    initResp.latencyMs < 2000,
    `initialize latency ${initResp.latencyMs}ms exceeds 2s budget`
  );
  assert.equal(initResp.obj.result.serverInfo.name, 'xlsx-for-ai');
  assert.equal(initResp.obj.result.capabilities.tools.listChanged, true,
    'must advertise tools.listChanged so background upgrades reach clients');
});

test('tools/list serves the bundled catalog before any network upgrade lands', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-init-test-'));
  const child = spawn('node', [MCP_PATH], {
    env: {
      ...process.env,
      XLSX_FOR_AI_API: BLACK_HOLE_API,
      XFA_CONFIG_DIR: tmpDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const responses = new Map();
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id) responses.set(obj.id, obj);
          if (responses.has(1) && responses.has(2)) resolve();
        } catch (_) {}
      }
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('tools/list did not respond within 3s')), 3000).unref();
  });

  child.stdin.write(rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(rpc(2, 'tools/list', {}));

  try {
    await done;
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  const listResp = responses.get(2);
  assert.ok(listResp && listResp.result, 'tools/list must respond');
  const tools = listResp.result.tools;
  assert.ok(Array.isArray(tools), 'tools must be an array');
  assert.ok(tools.length >= 40,
    `bundled catalog must serve the floor (got ${tools.length}); upgrade is additive`);
  for (const t of tools) {
    assert.equal(typeof t.name, 'string', 'every tool needs a name');
    assert.ok(t.inputSchema, 'every tool needs an inputSchema');
    assert.equal(typeof t.description, 'string',
      `tool ${t.name} needs a description (Claude Desktop drops tools without one)`);
    assert.ok(t.description.length > 0,
      `tool ${t.name} description must be non-empty`);
  }
});

test('upgrade path: stub server tools get a sanitized inputSchema + description floor', async () => {
  // Reproduce the SPM P0 second-bug condition: a fake server that returns
  // 50 stub tools (no inputSchema, no description), the exact shape the
  // hosted /api/v1/tools/list currently emits. Confirm tools/list after
  // the background upgrade STILL exposes every tool with both fields —
  // otherwise Claude Desktop drops the catalog and no tool is callable.
  const http = require('node:http');

  const STUB_NAMES = ['xlsx_brand_new_server_only', 'xlsx_read'];  // one server-only, one overlap
  const STUB_RESPONSE = {
    tools: STUB_NAMES.map((name) => ({
      name,
      category: 'analysis',
      maturity_state: 'new',
      endpoint: `POST /api/v1/tools/${name}`,
    })),
  };

  const stubServer = http.createServer((req, res) => {
    if (req.url === '/api/v1/tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(STUB_RESPONSE));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  const port = stubServer.address().port;
  const stubBase = `http://127.0.0.1:${port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-init-test-'));
  const child = spawn('node', [MCP_PATH], {
    env: {
      ...process.env,
      XLSX_FOR_AI_API: stubBase,
      XFA_CONFIG_DIR: tmpDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const responses = new Map();
  let sawListChanged = false;
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id) responses.set(obj.id, obj);
          if (obj.method === 'notifications/tools/list_changed') {
            sawListChanged = true;
            // Re-query tools/list after the upgrade lands.
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0', id: 9, method: 'tools/list',
            }) + '\n');
          }
          if (responses.has(9)) resolve();
        } catch (_) {}
      }
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('upgrade did not land within 8s')), 8000).unref();
  });

  child.stdin.write(rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  try {
    await done;
  } finally {
    child.kill('SIGTERM');
    stubServer.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  assert.ok(sawListChanged, 'background upgrade should emit tools/list_changed');
  const upgradedList = responses.get(9);
  assert.ok(upgradedList && upgradedList.result, 'tools/list after upgrade must respond');
  const tools = upgradedList.result.tools;
  assert.ok(Array.isArray(tools));
  // Stub server contributed: 1 server-only + 1 overlap with baked. Baked
  // floor adds the other 47. Total = remote (2) + baked-only (47) = 49.
  assert.ok(tools.length > 0, 'upgraded catalog must have tools');
  // Find the stub server-only tool — it must have been floored.
  const serverOnly = tools.find((t) => t.name === 'xlsx_brand_new_server_only');
  assert.ok(serverOnly, 'server-only stub tool must survive the upgrade');
  assert.ok(serverOnly.inputSchema,
    'server-only stub tool must get a sanitized inputSchema (else Desktop drops it)');
  assert.equal(typeof serverOnly.description, 'string',
    'server-only stub tool must get a sanitized description');
  assert.ok(serverOnly.description.length > 0);
  // The overlap (xlsx_read) must have preserved its bundled inputSchema.
  const overlap = tools.find((t) => t.name === 'xlsx_read');
  assert.ok(overlap, 'overlapping tool must survive');
  assert.ok(overlap.inputSchema && overlap.inputSchema.properties,
    'overlapping tool must keep the bundled inputSchema (mergeTools field-merge)');
  // EVERY tool must have non-empty inputSchema + description. This is the
  // load-bearing assertion — anything else and Desktop drops the catalog.
  for (const t of tools) {
    assert.ok(t.inputSchema, `${t.name} missing inputSchema after upgrade`);
    assert.equal(typeof t.description, 'string',
      `${t.name} missing description after upgrade`);
    assert.ok(t.description.length > 0,
      `${t.name} has empty description after upgrade`);
  }
});
