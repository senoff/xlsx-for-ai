'use strict';

/**
 * XLS-2989: the MCP server has no terminal, so with no stored key a tool call
 * must answer with a sign-in link and code (not a dead end), keep polling in
 * the background, and work on the next call once the user approves.
 *
 * Runs the real mcp.js as a child process with an empty config directory and
 * piped stdio, against a local stub of the sign-in service. Never touches the
 * real API.
 *
 * (Lives in test/v2 so the repo's `node --test test/v2/*.test.js` glob runs it.)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startStub, API_KEY } = require('./helpers/device-login-stub');

const MCP_PATH = path.join(__dirname, '..', '..', 'mcp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const stub = await startStub();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-signin-cfg-'));
  const csv = path.join(cfg, 'sample.csv');
  fs.writeFileSync(csv, 'a,b\n1,2\n');
  const env = { ...process.env, XLSX_FOR_AI_API: stub.base, XFA_CONFIG_DIR: cfg, XFA_NO_AUTO_UPDATE: '1' };
  delete env.CI; delete env.GITHUB_ACTIONS; delete env.XLSX_FOR_AI_CI; delete env.XFA_NONINTERACTIVE;
  const child = spawn(process.execPath, [MCP_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  let nextId = 1;
  const waiters = new Map();
  const stdoutLines = [];
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      try {
        const o = JSON.parse(line);
        if (o.id !== undefined && waiters.has(o.id)) waiters.get(o.id)(o);
      } catch (_) { /* recorded in stdoutLines, checked below */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} did not answer in 10s`)), 10000);
    waiters.set(id, (o) => { clearTimeout(t); resolve(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const callTool = async () => {
    const r = await rpc('tools/call', { name: 'xlsx_list_sheets', arguments: { file_path: csv } });
    assert.ok(r.result, 'tools/call must return a result, not a JSON-RPC error');
    return r.result;
  };

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  try {
    await fn({ stub, cfg, rpc, callTool, stdoutLines, approve: () => fetch(stub.base + '/__approve', { method: 'POST' }) });
  } finally {
    child.kill('SIGTERM');
    await stub.close();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

const textOf = (result) => result.content.map((c) => c.text).join('\n');

async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

// config.json also holds the cached device client id before sign-in ends, so
// "the file exists" is not "the key is stored".
function hasKey(cfg) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8')).api_key);
  } catch (_) {
    return false;
  }
}

test('tools/list answers with no key and starts no sign-in', async () => {
  await withServer(async ({ rpc, stub }) => {
    const list = await rpc('tools/list', {});
    assert.ok(list.result.tools.length >= 40);
    await sleep(300);
    assert.equal(stub.state.deviceRequests, 0, 'start-up must not request a code');
  });
});

test('first call shows the link and code; after approval the next call works with the stored key', async () => {
  await withServer(async ({ stub, cfg, callTool, approve, stdoutLines }) => {
    const first = await callTool();
    const text = textOf(first);
    assert.notEqual(first.isError, true, 'a normal result, not isError');
    assert.match(text, /oauth\/device\?user_code=STUB-0001/, 'carries the verification link');
    assert.match(text, /STUB-0001/, 'carries the code');
    assert.equal(stub.state.deviceRequests, 1);
    assert.equal(stub.state.unauthorizedToolCalls, 0, 'no tool call went out without a key');

    await approve();
    assert.ok(
      await waitFor(() => hasKey(cfg)),
      'the background poll stores the key after approval'
    );
    const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8'));
    assert.equal(stored.api_key, API_KEY);

    const second = await callTool();
    assert.equal(textOf(second), 'STUB TOOL RESULT: sheets = [Sheet1]');
    assert.equal(stub.state.toolCalls.length, 1);
    assert.equal(stub.state.deviceRequests, 1, 'no second device request');

    for (const line of stdoutLines) {
      const o = JSON.parse(line); // throws on any non-JSON byte line
      assert.equal(o.jsonrpc, '2.0', 'stdout carries only JSON-RPC');
    }
  });
});

test('a repeat call while sign-in is pending returns the same link and code, with no second request', async () => {
  await withServer(async ({ stub, callTool }) => {
    const a = textOf(await callTool());
    const b = textOf(await callTool());
    const c = await Promise.all([callTool(), callTool()]);
    const linkLine = (t) => t.split('\n').find((l) => l.includes('Open this link'));
    assert.equal(linkLine(b), linkLine(a), 'the same link');
    assert.match(a, /STUB-0001/);
    assert.match(b, /STUB-0001/);
    for (const r of c) assert.match(textOf(r), /STUB-0001/);
    assert.equal(stub.state.deviceRequests, 1);
  });
});

test('an expired code starts a fresh one on the next call', async () => {
  await withServer(async ({ stub, callTool }) => {
    assert.match(textOf(await callTool()), /STUB-0001/);
    await fetch(stub.base + '/__expire', { method: 'POST' });
    // the poll hits expired_token on its next tick (1s interval) and drops the code
    assert.ok(await waitFor(async () => (await (await fetch(stub.base + '/__stats')).json()).tokenPolls >= 1));
    await sleep(500);
    const next = textOf(await callTool());
    assert.match(next, /STUB-0002/, 'a new code, not the dead one');
    assert.equal(stub.state.deviceRequests, 2);
  });
});

test('stdout carries only JSON-RPC even while sign-in starts, polls and ends', async () => {
  await withServer(async ({ callTool, approve, cfg, stdoutLines }) => {
    await callTool();
    await approve();
    assert.ok(await waitFor(() => hasKey(cfg)));
    assert.equal(textOf(await callTool()), 'STUB TOOL RESULT: sheets = [Sheet1]');
    assert.ok(stdoutLines.length >= 3);
    for (const line of stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line.slice(0, 60)}`);
  });
});

test('an unreachable sign-in service gives a plain error result, not a hang or crash', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-signin-cfg-'));
  const csv = path.join(cfg, 'sample.csv');
  fs.writeFileSync(csv, 'a,b\n1,2\n');
  const env = { ...process.env, XLSX_FOR_AI_API: 'http://127.0.0.1:1', XFA_CONFIG_DIR: cfg, XFA_NO_AUTO_UPDATE: '1' };
  delete env.CI; delete env.GITHUB_ACTIONS; delete env.XLSX_FOR_AI_CI;
  const child = spawn(process.execPath, [MCP_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.id !== undefined && waiters.has(o.id)) waiters.get(o.id)(o);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
    waiters.set(id, (o) => { clearTimeout(t); resolve(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const r = await rpc(2, 'tools/call', { name: 'xlsx_list_sheets', arguments: { file_path: csv } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /sign-in/i);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});
