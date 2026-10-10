'use strict';

/**
 * XLS-3001: what a person must see at the package's front door.
 *
 * Runs the real index.js (terminal command) and mcp.js (MCP server) as child
 * processes with an empty config directory and piped stdio against the local
 * stand-in for the sign-in service and tool API. Never touches the real API.
 * Each test is named with the id of the spec line it settles.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startStub, API_KEY } = require('./helpers/device-login-stub');

const ROOT = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(ROOT, 'index.js');
const MCP_PATH = path.join(ROOT, 'mcp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

function baseEnv(stub, cfg, extra = {}) {
  const env = {
    ...process.env,
    XLSX_FOR_AI_API: stub.base,
    XFA_CONFIG_DIR: cfg,
    XFA_NO_AUTO_UPDATE: '1',
    ...extra,
  };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE', 'XFA_LOGIN_WAIT_SECONDS']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function storeKey(cfg, key) {
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ client_id: 'stub-client-1', api_key: key }));
}
function readCfg(cfg) {
  try { return JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8')); } catch (_) { return null; }
}
const hasKey = (cfg) => Boolean(readCfg(cfg) && readCfg(cfg).api_key);
// The sign-in request waiting for approval has its own file beside the config.
const pendingFile = (cfg) => path.join(cfg, 'pending-login.json');
function readPending(cfg) {
  try { return JSON.parse(fs.readFileSync(pendingFile(cfg), 'utf8')); } catch (_) { return null; }
}
const leftovers = (cfg) => fs.readdirSync(cfg).filter((f) => /\.tmp$|\.lock$/.test(f));
const post = (stub, p, body) => fetch(stub.base + p, { method: 'POST', body: JSON.stringify(body || {}) });

async function withStub(fn, { setup } = {}) {
  const stub = await startStub();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-front-door-'));
  const csv = path.join(cfg, 'sample.csv');
  fs.writeFileSync(csv, 'a,b\n1,2\n');
  try {
    if (setup) await setup({ stub, cfg });
    await fn({ stub, cfg, csv });
  } finally {
    await stub.close();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

// Run the terminal command with piped stdio (no terminal), return when it exits.
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Start the MCP server, return a tiny client.
async function startMcp(env, csv) {
  const child = spawn(process.execPath, [MCP_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const waiters = new Map();
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id !== undefined && waiters.has(o.id)) waiters.get(o.id)(o);
      } catch (_) { /* not JSON-RPC */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} did not answer in 60s`)), 60000);
    waiters.set(id, (o) => { clearTimeout(t); resolve(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (filePath = csv) => {
    const r = await rpc('tools/call', { name: 'xlsx_list_sheets', arguments: { file_path: filePath } });
    assert.ok(r.result, 'tools/call must return a result');
    return r.result;
  };
  return { call, rpc, stop: () => child.kill('SIGTERM') };
}
const textOf = (result) => result.content.map((c) => c.text).join('\n');

async function withMcp(fn, { setup } = {}) {
  await withStub(async ({ stub, cfg, csv }) => {
    const mcp = await startMcp(baseEnv(stub, cfg), csv);
    try {
      await fn({ stub, cfg, csv, mcp });
    } finally {
      mcp.stop();
    }
  }, { setup });
}

const PAYWALL_402 = {
  error: {
    code: 'upgrade_required',
    message: 'You have used your 500 free files this month.',
    upgrade: { url: 'https://xlsx-for-ai.dev/upgrade?from=test', plan: 'pro', reason: 'plan1_monthly_over' },
  },
};
const LIMIT_429 = {
  error: { code: 'rate_limited', message: 'Too many requests from this IP; slow down.', retry_after_seconds: 12 },
};
const GAP_501 = {
  error: { code: 'capability_gap', message: 'The function XLOOKUP2 is not built yet in our own engine.' },
};

// ---------------------------------------------------------------------------
// B2-2 (and B2-16): the terminal command with no terminal
// ---------------------------------------------------------------------------

test('B2-2: no terminal, no key: link and code on stderr, the command waits, and finishes when approved', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '20' });
    const run = runCli([csv], env);
    assert.ok(await waitFor(() => stub.state.deviceRequests === 1), 'a sign-in request was made');
    await post(stub, '/__approve');
    const r = await run;
    assert.equal(r.code, 0, `exit 0; stderr: ${r.stderr}`);
    assert.match(r.stderr, /oauth\/device\?user_code=STUB-0001/, 'link on stderr');
    assert.match(r.stderr, /STUB-0001/, 'code on stderr');
    assert.match(r.stdout, /STUB TOOL RESULT/, 'the command did its work in the same run');
    assert.equal(stub.state.unauthorizedToolCalls, 0, 'no request went out without a key');
    assert.equal(readCfg(cfg).api_key, API_KEY);
    assert.equal(fs.existsSync(pendingFile(cfg)), false, 'the saved request is dropped once used');
    assert.deepEqual(leftovers(cfg), [], 'no temp or lock file is left behind');
  });
});

test('B2-2: not approved in time: exits non-zero with "approve, then run the same command again", names no terminal', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '1.5' });
    const r = await runCli([csv], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /oauth\/device\?user_code=STUB-0001/);
    assert.match(r.stderr, /STUB-0001/);
    assert.match(r.stderr, /approve/i);
    assert.match(r.stderr, /run the same command again/i);
    assert.doesNotMatch(r.stderr, /in a terminal/i, 'never sends the person somewhere they are not');
    assert.equal(r.stdout, '', 'stdout stays clean');
    assert.equal(hasKey(cfg), false);
    assert.equal(readPending(cfg).userCode, 'STUB-0001', 'the pending request is saved for the rerun');
    assert.equal((readCfg(cfg) || {}).pending_login, undefined, 'it is kept out of the config file that holds the key');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(pendingFile(cfg)).mode & 0o077, 0, 'only the owner can read the saved request');
    }
    assert.deepEqual(leftovers(cfg), []);
  });
});

test('B2-2: the rerun resumes the SAME code and finishes at once when it was approved meanwhile', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '1.5' });
    const first = await runCli([csv], env);
    assert.notEqual(first.code, 0);
    assert.equal(stub.state.deviceRequests, 1);

    await post(stub, '/__approve');
    const started = Date.now();
    const second = await runCli([csv], env);
    assert.equal(second.code, 0, `stderr: ${second.stderr}`);
    assert.match(second.stdout, /STUB TOOL RESULT/);
    assert.match(second.stderr, /STUB-0001/, 'the same code, not a new one');
    assert.equal(stub.state.deviceRequests, 1, 'no second sign-in request');
    assert.ok(Date.now() - started < 8000, 'finished at once, without waiting out the window');
    assert.equal(readCfg(cfg).api_key, API_KEY);
    assert.equal(fs.existsSync(pendingFile(cfg)), false);
  });
});

test('B2-2: a saved request that has run out is dropped and a fresh code is shown', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '1.5' });
    await runCli([csv], env);
    await post(stub, '/__expire');
    const again = await runCli([csv], env);
    assert.notEqual(again.code, 0);
    assert.equal(stub.state.deviceRequests, 2, 'a second request was started');
    assert.match(again.stderr, /STUB-0002/, 'the fresh code is shown');
    assert.equal(readPending(cfg).userCode, 'STUB-0002');

    // A saved request whose time is already up is not used, without asking the service.
    const p = readPending(cfg);
    p.expiresAtMs = Date.now() - 1000;
    fs.writeFileSync(pendingFile(cfg), JSON.stringify(p));
    const polls = stub.state.tokenPolls;
    const third = await runCli([csv], env);
    assert.notEqual(third.code, 0);
    assert.match(third.stderr, /STUB-0003/);
    assert.doesNotMatch(third.stderr, /STUB-0002/);
    assert.equal(readPending(cfg).userCode, 'STUB-0003', 'the fresh request replaced the old file');
    assert.ok(stub.state.tokenPolls - polls <= 2, 'the run-out code was not polled');
  });
});

test('B2-2: a saved request that is damaged or for another service is not used; a fresh code is shown', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' });
    fs.writeFileSync(pendingFile(cfg), '{"origin": "http://127.0.0.1:1", "deviceCo');
    const first = await runCli([csv], env);
    assert.match(first.stderr, /STUB-0001/);
    assert.match(first.stderr, /run the same command again/i);
    fs.writeFileSync(pendingFile(cfg), JSON.stringify({ ...readPending(cfg), origin: 'https://other.example' }));
    const second = await runCli([csv], env);
    assert.match(second.stderr, /STUB-0002/, 'a request saved for another service address is not resumed');
    assert.doesNotMatch(second.stderr, /Unexpected|SyntaxError|at .*\.js:\d+/);
  });
});

test('B2-2: XFA_NONINTERACTIVE=1 keeps the fail-fast for people who asked for it', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_NONINTERACTIVE: '1' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not signed in/i);
    assert.match(r.stderr, /xlsx-for-ai login/);
    assert.equal(stub.state.deviceRequests, 0, 'no sign-in started');
  });
});

test('B2-2: an automated run (CI=true) never starts a sign-in', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await runCli([csv], baseEnv(stub, cfg, { CI: 'true' }));
    assert.equal(stub.state.deviceRequests, 0);
  });
});

test('B2-16: stamp (another command) follows the same sign-in rules as a read', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli(['stamp', csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /STUB-0001/);
    assert.match(r.stderr, /run the same command again/i);
  });
});

// ---------------------------------------------------------------------------
// B1-15 / B1-18 / B1-26 (and B2-9): 402, 429, 501 on both surfaces
// ---------------------------------------------------------------------------

const SCRIPTED = (status, body) => async ({ stub, cfg }) => {
  storeKey(cfg, API_KEY);
  await post(stub, '/__config', { toolResponse: { status, body } });
};

test('B1-15: MCP, free files used up: the server\'s sentence and its upgrade link are shown', async () => {
  await withMcp(async ({ mcp }) => {
    const out = textOf(await mcp.call());
    assert.match(out, /You have used your 500 free files this month\./);
    assert.match(out, /https:\/\/xlsx-for-ai\.dev\/upgrade(?![?\w])/);
    assert.doesNotMatch(out, /from=test/, 'the link\'s query string is not echoed');
    assert.doesNotMatch(out, /capture mode/);
  }, { setup: SCRIPTED(402, PAYWALL_402) });
});

test('B2-9: terminal, free files used up: the server\'s sentence and its upgrade link are shown', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /You have used your 500 free files this month\./);
    assert.match(r.stderr, /https:\/\/xlsx-for-ai\.dev\/upgrade(?![?\w])/);
    assert.doesNotMatch(r.stderr, /from=test/, 'the link\'s query string is not echoed');
    assert.doesNotMatch(r.stderr, /capture mode/);
  }, { setup: SCRIPTED(402, PAYWALL_402) });
});

test('B1-18: MCP, a short limit: the server\'s reason and how long to wait, not "resets next month"', async () => {
  await withMcp(async ({ mcp }) => {
    const out = textOf(await mcp.call());
    assert.match(out, /Too many requests from this IP; slow down\./);
    assert.match(out, /12 seconds/);
    assert.doesNotMatch(out, /monthly request cap|next month/);
  }, { setup: SCRIPTED(429, LIMIT_429) });
});

test('B2-9: terminal, a short limit: the server\'s reason and how long to wait', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.match(r.stderr, /Too many requests from this IP; slow down\./);
    assert.match(r.stderr, /12 seconds/);
    assert.doesNotMatch(r.stderr, /monthly request cap|next month/);
  }, { setup: SCRIPTED(429, LIMIT_429) });
});

test('B1-26: MCP, a function not built yet: shown as that, not "retry shortly"', async () => {
  await withMcp(async ({ mcp }) => {
    const out = textOf(await mcp.call());
    assert.match(out, /XLOOKUP2 is not built yet/);
    assert.doesNotMatch(out, /retry shortly|server error/i);
  }, { setup: SCRIPTED(501, GAP_501) });
});

test('B1-26: terminal, a function not built yet: shown as that, not "retry shortly"', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.match(r.stderr, /XLOOKUP2 is not built yet/);
    assert.doesNotMatch(r.stderr, /retry shortly|server error/i);
  }, { setup: SCRIPTED(501, GAP_501) });
});

test('B1-26: a real server fault (500) still says to try again shortly', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.match(r.stderr, /retry shortly/);
  }, { setup: SCRIPTED(500, { error: { message: 'internal stack trace at x:42' } }) });
});

// ---------------------------------------------------------------------------
// B1-8: a sign-in that ended badly is explained before the fresh link
// ---------------------------------------------------------------------------

test('B1-8: a declined sign-in is explained on the next request, before the new link', async () => {
  await withMcp(async ({ stub, mcp }) => {
    assert.match(textOf(await mcp.call()), /STUB-0001/);
    await post(stub, '/__config', { declineOnApprove: true });
    await post(stub, '/__approve');
    assert.ok(await waitFor(async () => (await (await fetch(stub.base + '/__stats')).json()).tokenPolls >= 1));
    await sleep(600);
    const next = textOf(await mcp.call());
    const said = next.search(/declined/i);
    assert.ok(said >= 0, `explains what happened; got: ${next}`);
    assert.ok(said < next.indexOf('STUB-0002'), 'the explanation comes before the fresh link');
    assert.match(next, /oauth\/device\?user_code=STUB-0002/);
    assert.doesNotMatch(next, /terminal/i);
  });
});

test('B1-8: approval that could not make a key is explained, not repeated silently', async () => {
  await withMcp(async ({ stub, mcp }) => {
    assert.match(textOf(await mcp.call()), /STUB-0001/);
    await post(stub, '/__config', { clientsStatus: 500 });
    await post(stub, '/__approve');
    assert.ok(await waitFor(async () => (await (await fetch(stub.base + '/__stats')).json()).tokenPolls >= 1));
    await sleep(800);
    const next = textOf(await mcp.call());
    assert.match(next, /approved the last sign-in/i);
    assert.match(next, /could not create your key/i);
    assert.match(next, /STUB-0002/);
  });
});

test('B1-8: approval whose key could not be saved on this computer is explained', async () => {
  await withMcp(async ({ stub, cfg, mcp }) => {
    assert.match(textOf(await mcp.call()), /STUB-0001/);
    // Make the config file impossible to write: a folder sits where config.json goes.
    fs.rmSync(path.join(cfg, 'config.json'));
    fs.mkdirSync(path.join(cfg, 'config.json'));
    await post(stub, '/__approve');
    assert.ok(await waitFor(async () => (await (await fetch(stub.base + '/__stats')).json()).tokenPolls >= 1));
    await sleep(800);
    const next = textOf(await mcp.call());
    assert.match(next, /could not be saved on this computer/i);
    assert.match(next, /STUB-0002/);
  });
});

// ---------------------------------------------------------------------------
// B1-11 / B2-7: a stored key the server turns down
// ---------------------------------------------------------------------------

test('B1-11: MCP, a stored key the server rejects: a fresh sign-in link on that same request; the old key stays until a new one is saved', async () => {
  await withMcp(async ({ stub, cfg, mcp }) => {
    const first = await mcp.call();
    const out = textOf(first);
    assert.notEqual(first.isError, true);
    assert.match(out, /not accepted/i);
    assert.match(out, /oauth\/device\?user_code=STUB-0001/);
    assert.doesNotMatch(out, /terminal/i);
    assert.equal(readCfg(cfg).api_key, 'xfa_old_key', 'the stored key is not deleted yet');

    // Asking again shows the same link, not a new one each time.
    assert.match(textOf(await mcp.call()), /STUB-0001/);
    assert.equal(stub.state.deviceRequests, 1);

    await post(stub, '/__approve');
    assert.ok(await waitFor(() => readCfg(cfg).api_key === API_KEY), 'the new key replaces the old one');
    assert.equal(textOf(await mcp.call()), 'STUB TOOL RESULT: sheets = [Sheet1]');
  }, { setup: ({ cfg }) => storeKey(cfg, 'xfa_old_key') });
});

test('B2-7: terminal, a stored key the server rejects: names the exact command `xlsx-for-ai login --force`', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /`xlsx-for-ai login --force`/);
    assert.equal(readCfg(cfg).api_key, 'xfa_old_key', 'the stored key is not deleted');
  }, { setup: ({ cfg }) => storeKey(cfg, 'xfa_old_key') });
});

// ---------------------------------------------------------------------------
// B1-6 / B1-7: sign-in service unreachable inside a host
// ---------------------------------------------------------------------------

test('B1-6: MCP, sign-in service unreachable: plain "try again in a minute", no terminal, no command', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-front-door-'));
  const csv = path.join(cfg, 'sample.csv');
  fs.writeFileSync(csv, 'a,b\n1,2\n');
  const env = { ...process.env, XLSX_FOR_AI_API: 'http://127.0.0.1:1', XFA_CONFIG_DIR: cfg, XFA_NO_AUTO_UPDATE: '1' };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE']) delete env[k];
  const mcp = await startMcp(env, csv);
  try {
    const r = await mcp.call();
    const out = textOf(r);
    assert.equal(r.isError, true);
    assert.match(out, /the sign-in service did not answer, try again in a minute|sign-in service did not answer\. Please try again in a minute/i);
    assert.doesNotMatch(out, /terminal/i);
    assert.doesNotMatch(out, /xlsx-for-ai login/);
  } finally {
    mcp.stop();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B2-11 / B1-23: a link given as a file path
// ---------------------------------------------------------------------------

const LINKS = ['https://example.com/report.xlsx', 'http://example.com/a.csv', 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0'];

test('B2-11: terminal, a pasted link: says this door reads local files only and what to do, not "File not found"', async () => {
  await withStub(async ({ stub, cfg }) => {
    for (const link of LINKS) {
      const r = await runCli([link], baseEnv(stub, cfg));
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /files saved on this computer only/);
      assert.match(r.stderr, /Download the file/);
      assert.match(r.stderr, /hosted xlsx-for-ai connector/);
      assert.doesNotMatch(r.stderr, /File not found/i);
    }
    assert.equal(stub.state.deviceRequests, 0, 'no sign-in is started for a link we cannot read');
  });
});

test('B1-23: MCP, a pasted link: says this door reads local files only and what to do, not "file not found"', async () => {
  await withMcp(async ({ mcp }) => {
    for (const link of LINKS) {
      const r = await mcp.call(link);
      const out = textOf(r);
      assert.match(out, /files saved on this computer only/);
      assert.match(out, /Download the file/);
      assert.match(out, /hosted xlsx-for-ai connector/);
      assert.doesNotMatch(out, /not found/i);
    }
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

// ---------------------------------------------------------------------------
// B1-13 / B1-28: packaging and start-up
// ---------------------------------------------------------------------------

test('B1-13: the Docker image does not mark every person an automated run', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(docker, /XLSX_FOR_AI_CI/);
  assert.doesNotMatch(docker, /\bCI\s*=/);
  assert.doesNotMatch(docker, /GITHUB_ACTIONS/);
});

test('B1-28: start-up never begins a sign-in on its own, even where a terminal is attached', async () => {
  await withStub(async ({ stub, cfg }) => {
    const saved = {};
    for (const k of ['XLSX_FOR_AI_API', 'XFA_CONFIG_DIR', 'CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE']) saved[k] = process.env[k];
    process.env.XLSX_FOR_AI_API = stub.base;
    process.env.XFA_CONFIG_DIR = cfg;
    for (const k of ['CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE']) delete process.env[k];
    const tty = (v) => {
      Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
    };
    try {
      tty(true);
      for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k];
      const { ensureRegistered } = require('../../lib/register');
      await assert.rejects(ensureRegistered({ signIn: false }), { code: 'LOGIN_REQUIRED' });
      assert.equal(stub.state.deviceRequests, 0);
    } finally {
      tty(false);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

test('B1-8: the sentence for each way a sign-in can end is plain and names no terminal', () => {
  const { failureSentence } = require('../../lib/mcp-signin');
  for (const reason of ['declined', 'expired', 'not_issued', 'not_saved', 'unreachable', 'failed', undefined]) {
    const s = failureSentence({ reason });
    assert.ok(s.length > 10 && s.length < 220, `short: ${s}`);
    assert.doesNotMatch(s, /terminal|xlsx-for-ai login/i);
  }
});

test('review: server.json top-level version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const srv = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
  assert.equal(srv.version, pkg.version);
  assert.equal(srv.packages[0].version, pkg.version);
});

test('review: XFA_NONINTERACTIVE=1 is not interactive even where a terminal is attached', () => {
  const saved = process.env.XFA_NONINTERACTIVE;
  const tty = (v) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
  };
  try {
    tty(true);
    const { isInteractive } = require('../../lib/register');
    process.env.XFA_NONINTERACTIVE = '1';
    assert.equal(isInteractive(), false);
    delete process.env.XFA_NONINTERACTIVE;
    assert.equal(isInteractive(), true);
  } finally {
    tty(false);
    if (saved === undefined) delete process.env.XFA_NONINTERACTIVE; else process.env.XFA_NONINTERACTIVE = saved;
  }
});

test('review: a sign-in that cannot be saved stops BEFORE the person is asked to approve, and says which folder to fix', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    // A folder sitting where the request file goes: the save cannot land.
    fs.mkdirSync(pendingFile(cfg));
    fs.writeFileSync(path.join(pendingFile(cfg), 'keep'), '');
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '20' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /could not be saved in /i);
    assert.ok(r.stderr.includes(cfg), 'names the folder');
    assert.match(r.stderr, /writable/i);
    assert.match(r.stderr, /run the same command again/i);
    assert.doesNotMatch(r.stderr, /STUB-0001|open this page/i, 'no code is shown for a sign-in that could not be kept');
    assert.doesNotMatch(r.stderr, /in a terminal/i);
    assert.equal(stub.state.tokenPolls, 0, 'nothing waited on an approval');
    assert.equal(hasKey(cfg), false);
    assert.deepEqual(leftovers(cfg), [], 'the temp file is cleaned up');
  });
});

// ---------------------------------------------------------------------------
// Review round 3
// ---------------------------------------------------------------------------

// Point this process's config and API at a stub for an in-process call, then restore.
async function inProcess(stub, cfg, env, fn) {
  const keys = ['XLSX_FOR_AI_API', 'XFA_CONFIG_DIR', 'CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE', 'XFA_LOGIN_WAIT_SECONDS'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  process.env.XLSX_FOR_AI_API = stub.base;
  process.env.XFA_CONFIG_DIR = cfg;
  for (const k of keys.slice(2)) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('review: two commands started together do not get in each other\'s way: each has its own code, both finish, the config is whole, and there is no lock', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    // A slow answer from the service, so the two commands overlap at every step.
    await post(stub, '/__config', { authDelayMs: 600 });
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '30' });
    const first = runCli([csv], env);
    const second = runCli([csv], env);
    assert.ok(await waitFor(() => stub.state.deviceRequests === 2, 15000), 'each command asked for its own code');
    const saved = readPending(cfg);
    assert.ok(saved && /^STUB-000[12]$/.test(saved.userCode), 'the saved request is one whole request, whichever was saved last');
    assert.equal(fs.existsSync(path.join(cfg, 'pending-login.lock')), false, 'no lock file exists while they run');
    await post(stub, '/__approve');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.code, 0, `first: ${a.stderr}`);
    assert.equal(b.code, 0, `second: ${b.stderr}`);
    assert.match(a.stdout, /STUB TOOL RESULT/);
    assert.match(b.stdout, /STUB TOOL RESULT/);
    const codes = [a, b].map((r) => r.stderr.match(/STUB-000\d/)[0]).sort();
    assert.deepEqual(codes, ['STUB-0001', 'STUB-0002'], 'each showed its own code');
    const c = readCfg(cfg);
    assert.equal(c.api_key, API_KEY, 'the key is saved');
    assert.equal(c.client_id, 'stub-client-1');
    assert.equal(c.pending_login, undefined);
    assert.equal(fs.existsSync(pendingFile(cfg)), false, 'the saved request is gone once signed in');
    assert.deepEqual(leftovers(cfg), [], 'no temp or lock file is left behind');
  });
});

test('review: a sign-in that ends for good drops its OWN saved request and leaves a newer one from another command alone', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { declineOnApprove: true });
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '30' });

    // Its own request: dropped, so the rerun is not sent back to a declined code.
    let run = runCli([csv], env);
    assert.ok(await waitFor(() => Boolean(readPending(cfg))), 'request 1 saved');
    await post(stub, '/__approve');
    let r = await run;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /declined/);
    assert.equal(fs.existsSync(pendingFile(cfg)), false, 'the declined request is not kept');

    // Another command saved a newer request meanwhile: that one stays.
    run = runCli([csv], env);
    assert.ok(await waitFor(() => Boolean(readPending(cfg))), 'request 2 saved');
    const newer = { ...readPending(cfg), deviceCode: 'DEV-OTHER', userCode: 'OTHER-0001' };
    fs.writeFileSync(pendingFile(cfg), JSON.stringify(newer));
    await post(stub, '/__approve');
    r = await run;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /declined/);
    assert.equal(readPending(cfg).userCode, 'OTHER-0001', 'the other command\'s request is untouched');
  });
});

test('review: a failed network call that only looks things up is tried again (up to 3 tries) (ran red on the old code: first failure ended the sign-in)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { regFailTimes: 2, authFailTimes: 2 });
    const env = baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '30' });
    const run = runCli([csv], env);
    assert.ok(await waitFor(() => stub.state.deviceRequests === 1, 20000), 'a code was issued after the retries');
    await post(stub, '/__approve');
    const r = await run;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.state.regCalls, 3);
    assert.equal(stub.state.authCalls, 3);
  });
});

test('review: after 3 failed tries the message says what happened and what to do', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { authFailTimes: 99 });
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '5' }));
    assert.notEqual(r.code, 0);
    assert.equal(stub.state.authCalls, 3, 'three tries, no more');
    assert.match(r.stderr, /refused the request \(HTTP 503\)/);
    assert.match(r.stderr, /Try again/);
  });
});

test('review: the call that issues the key is NOT retried; the message says nothing was saved and rerunning is safe (ran red: old message had no next step)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { clientsStatus: 500 });
    const run = runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '30' }));
    assert.ok(await waitFor(() => stub.state.deviceRequests === 1));
    await post(stub, '/__approve');
    const r = await run;
    assert.notEqual(r.code, 0);
    assert.equal(stub.state.clientsCalls, 1, 'one try only: a second could mint a second key');
    assert.match(r.stderr, /approved the sign-in/);
    assert.match(r.stderr, /Nothing was saved/);
    assert.match(r.stderr, /same command again is safe/);
    assert.equal(hasKey(cfg), false);
  });
});

test('review: XFA_NONINTERACTIVE=1 on a terminal fails fast before any sign-in branch (already right on the old code; this pins it, so it did not run red)', async () => {
  await withStub(async ({ stub, cfg }) => {
    const tty = (v) => {
      Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
    };
    await inProcess(stub, cfg, { XFA_NONINTERACTIVE: '1' }, async () => {
      try {
        tty(true);
        const { ensureRegistered } = require('../../lib/register');
        await assert.rejects(ensureRegistered(), { code: 'LOGIN_REQUIRED' });
        await assert.rejects(ensureRegistered({ signIn: true }), { code: 'LOGIN_REQUIRED' });
        assert.equal(stub.state.deviceRequests, 0);
      } finally { tty(false); }
    });
  });
});

test('review: wait text is singular for a count of 1 in every unit (ran red on the old code: describeWait was not exported)', () => {
  const { describeWait, pluralUnit } = require('../../lib/inline-4xx');
  assert.equal(describeWait(1), '1 second');
  assert.equal(describeWait(59), '59 seconds');
  assert.equal(describeWait(90), '2 minutes');
  assert.equal(describeWait(5340), '89 minutes');
  assert.equal(describeWait(5400), '2 hours');
  assert.equal(pluralUnit(1, 'minute'), '1 minute');
  assert.equal(pluralUnit(1, 'hour'), '1 hour');
  assert.equal(pluralUnit(2, 'hour'), '2 hours');
  assert.equal(pluralUnit(0, 'second'), '0 seconds');
});

test('review: an upgrade link is shown only if it is https on xlsx-for-ai.dev, and without its query or fragment', () => {
  const { extractUpgradeUrl } = require('../../lib/inline-4xx');
  const wrap = (url) => ({ error: { upgrade: { url } } });
  assert.equal(extractUpgradeUrl(wrap('https://xlsx-for-ai.dev/upgrade?from=x&email=a@b.c#frag')), 'https://xlsx-for-ai.dev/upgrade');
  assert.equal(extractUpgradeUrl(wrap('https://www.xlsx-for-ai.dev/pricing')), 'https://www.xlsx-for-ai.dev/pricing');
  assert.equal(extractUpgradeUrl(wrap('https://xlsx-for-ai.dev/?token=abc')), 'https://xlsx-for-ai.dev');
  for (const bad of ['https://evil.example/pay?token=abc', 'http://xlsx-for-ai.dev/upgrade', 'https://xlsx-for-ai.dev.evil.example/x',
    'https://user:pw@xlsx-for-ai.dev/x', 'https://xlsx-for-ai.dev:8443/x', 'not a url', 'javascript:alert(1)']) {
    assert.equal(extractUpgradeUrl(wrap(bad)), '', bad);
  }
});

test('review: an upgrade link\'s path is plain named segments only; `..`, `.`, `//`, escapes and backslashes never reach the screen (ran red on the old code: /a/../b was shown as /b, /..x and /a//b as sent)', () => {
  const { extractUpgradeUrl } = require('../../lib/inline-4xx');
  const wrap = (url) => ({ error: { upgrade: { url } } });
  const SITE = 'https://xlsx-for-ai.dev';
  assert.equal(extractUpgradeUrl(wrap(`${SITE}/plans/pro.html`)), `${SITE}/plans/pro.html`);
  assert.equal(extractUpgradeUrl(wrap(`${SITE}/upgrade/`)), `${SITE}/upgrade`);
  assert.equal(extractUpgradeUrl(wrap(SITE)), SITE);
  for (const odd of ['/a/../b', '/../admin', '/upgrade/..', '/./upgrade', '/..x', '/x..', '/a//b', '//evil.example/x',
    '/%2e%2e/admin', '/a/%2E%2E/b', '/a\\..\\b', '/.hidden', '/a/.', `/${'a'.repeat(200)}`, '/a/b/c/d/e/f/g/h/i']) {
    const shown = extractUpgradeUrl(wrap(`${SITE}${odd}?token=abc`));
    assert.equal(shown, SITE, `${odd} -> ${shown}`);
  }
});

test('review: XFA_DEBUG=1 masks tokens, keys, emails and file paths in its "Raw:" line (ran red on the old code: shown as sent)', async () => {
  const secret = 'Bearer abcdefghijklmnop123456';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
  const body = { error: { code: 'bad_request', message: `Bad input from person@example.com using ${secret} and ${jwt} at /Users/someone/secret/book.xlsx` } };
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_DEBUG: '1' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^Raw: /m, 'the debug line is still there');
    assert.doesNotMatch(r.stderr, /person@example\.com|abcdefghijklmnop123456|eyJhbGciOiJIUzI1NiJ9|\/Users\/someone/);
    assert.match(r.stderr, /<email>/);
    assert.match(r.stderr, /<bearer>/);
  }, { setup: SCRIPTED(400, body) });
});

test('review: a pasted link exits 4 with its message even when stderr is closed (no uncaught exception)', async () => {
  await withStub(async ({ stub, cfg }) => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_PATH, LINKS[0]], { env: baseEnv(stub, cfg), stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.destroy();
      child.on('close', resolve);
    });
    assert.equal(code, 4);
  });
});

test('review: a paywall answer with an untrusted upgrade link shows the plans page, not the link', async () => {
  const body = { error: { code: 'upgrade_required', message: 'You have used your free files.', upgrade: { url: 'https://evil.example/pay?token=SECRET123' } } };
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /evil\.example|SECRET123/);
    assert.match(r.stderr, /See the plans at https:\/\/xlsx-for-ai\.dev\./);
  }, { setup: SCRIPTED(402, body) });
});

test('review: the same exit code (4) for a pasted link on every command (ran red on the old code: the plain read exited 1)', async () => {
  await withStub(async ({ stub, cfg }) => {
    for (const args of [[LINKS[0]], ['heal', LINKS[0]], ['stamp', LINKS[0]]]) {
      const r = await runCli(args, baseEnv(stub, cfg));
      assert.equal(r.code, 4, `${args[0]}: ${r.stderr}`);
      assert.match(r.stderr, /files saved on this computer only/);
    }
  });
});

test('review: the "sign-in is waiting" text carries one prefix, added where it is shown (ran red on the old code: the message came pre-prefixed)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await inProcess(stub, cfg, {}, async () => {
      const { deviceLoginWithWindow } = require('../../lib/login');
      await assert.rejects(deviceLoginWithWindow({ waitMs: 0, out: () => {} }), (err) => {
        assert.equal(err.code, 'LOGIN_PENDING');
        assert.doesNotMatch(err.message, /^xlsx-for-ai/);
        assert.match(err.message, /^sign-in is waiting for you/);
        return true;
      });
    });
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
    assert.match(r.stderr, /^xlsx-for-ai: sign-in is waiting for you/m);
    assert.doesNotMatch(r.stderr, /xlsx-for-ai[^\n]*xlsx-for-ai: sign-in/);
  });
});

test('review: XFA_LOGIN_WAIT_SECONDS is capped at 900, bad values fall back to 60, and the raw value is never printed (ran red: 99999 was used as given)', () => {
  const { signInWaitMs } = require('../../lib/login');
  const saved = process.env.XFA_LOGIN_WAIT_SECONDS;
  const notes = [];
  try {
    const wait = (v) => { process.env.XFA_LOGIN_WAIT_SECONDS = v; return signInWaitMs((s) => notes.push(s)); };
    assert.equal(wait('30'), 30000);
    assert.equal(wait('900'), 900000);
    assert.equal(wait('99999'), 900000);
    assert.equal(wait('abc-secret'), 60000);
    assert.equal(wait('-5'), 60000);
    assert.equal(wait('   '), 60000);
    assert.equal(notes.length, 4);
    for (const n of notes) assert.doesNotMatch(n, /99999|abc-secret|-5/, 'raw value not printed');
    delete process.env.XFA_LOGIN_WAIT_SECONDS;
    assert.equal(signInWaitMs(), 60000);
  } finally {
    if (saved === undefined) delete process.env.XFA_LOGIN_WAIT_SECONDS; else process.env.XFA_LOGIN_WAIT_SECONDS = saved;
  }
});

test('review: when the sign-in client id cannot be remembered, one line on stderr says so (ran red on the old code: silent)', async (t) => {
  if (process.platform === 'win32') { t.skip('symlink'); return; }
  await withStub(async ({ stub, cfg, csv }) => {
    const real = path.join(cfg, 'real-config.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, path.join(cfg, 'config.json'));
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
    const lines = r.stderr.split('\n').filter((l) => /could not remember the sign-in client/.test(l));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /writable/);
  });
});

test('review: the Docker image names the config folder it already reads (XFA_CONFIG_DIR) (ran red on the old code: not set)', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(docker, /XFA_CONFIG_DIR=\/home\/node\/\.xlsx-for-ai\b/);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'config.js'), 'utf8'), /process\.env\.XFA_CONFIG_DIR/);
});

test('review: an app-side LOGIN_FAILED says the real reason when known, and keeps the plain retry line for an unreachable service', () => {
  const { friendlyErrorMessage } = require('../../mcp');
  const declined = friendlyErrorMessage('xlsx_read', { code: 'LOGIN_FAILED', reason: 'declined' });
  assert.match(declined, /declined/);
  assert.doesNotMatch(declined, /terminal|xlsx-for-ai login/i);
  assert.match(friendlyErrorMessage('xlsx_read', { code: 'LOGIN_FAILED', reason: 'unreachable' }), /did not answer/);
});

// ===========================================================================
// XLS-3009: batch 2
// ===========================================================================

const readText = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SERVER_SHOWN_AS = 'plugin:xlsx-for-ai:spreadsheets';

// Code lines only: comments are explanation, not text a person sees.
function codeLines(text) {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}
function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
// A throwing stderr, loaded with `node -r`: every write to stderr fails at once.
function throwingStderrPreload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-preload-'));
  const file = path.join(dir, 'closed-stderr.js');
  fs.writeFileSync(file, "process.stderr.write = function () { throw new Error('stderr is closed'); };\n");
  return { file, dir };
}
function runCliWith(args, env, nodeArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI_PATH, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
// An older release, unpacked from a git tag next to the real dependencies.
function oldCopy(tag) {
  const ok = require('node:child_process').spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
  if (ok.status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xfa-${tag}-`));
  const tarFile = path.join(dir, 'src.tar');
  const a = require('node:child_process').spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tarFile, tag]);
  if (a.status !== 0) return null;
  const t = require('node:child_process').spawnSync('tar', ['-xf', tarFile, '-C', dir]);
  if (t.status !== 0) return null;
  fs.rmSync(tarFile);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function runOldCli(dir, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'index.js'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function startOldMcp(dir, env, csv) {
  const child = spawn(process.execPath, [path.join(dir, 'mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; let err = ''; let nextId = 1;
  const waiters = new Map();
  child.stderr.on('data', (c) => { err += c; });
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const o = JSON.parse(line); if (o.id !== undefined && waiters.has(o.id)) waiters.get(o.id)(o); } catch (_) { /* not JSON-RPC */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} did not answer`)), 60000);
    waiters.set(id, (o) => { clearTimeout(t); resolve(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    call: async () => (await rpc('tools/call', { name: 'xlsx_list_sheets', arguments: { file_path: csv } })).result,
    stderr: () => err,
    stop: () => child.kill('SIGTERM'),
  };
}

// ---------------------------------------------------------------------------
// Plugin text and the limits line
// ---------------------------------------------------------------------------

test('plugin text: the SKILL and the session-start text name the server exactly as it is registered', () => {
  const mcp = JSON.parse(readText('claude-code-plugin', '.mcp.json'));
  const servers = mcp.mcpServers || mcp;
  assert.deepEqual(Object.keys(servers), ['spreadsheets'], 'the registered key');
  assert.equal(SERVER_SHOWN_AS, 'plugin:xlsx-for-ai:spreadsheets');
  const skill = readText('claude-code-plugin', 'skills', 'spreadsheets', 'SKILL.md');
  const start = readText('claude-code-plugin', 'hooks', 'session-start.txt');
  for (const [name, text] of [['SKILL.md', skill], ['session-start.txt', start]]) {
    assert.ok(text.includes(SERVER_SHOWN_AS), `${name} names ${SERVER_SHOWN_AS}`);
  }
});

test('plugin text: the limits line matches the product (xlsx 100MB, xls 100MB, csv 200MB, every plan) and no "free tier" size limit', () => {
  const skill = readText('claude-code-plugin', 'skills', 'spreadsheets', 'SKILL.md');
  const start = readText('claude-code-plugin', 'hooks', 'session-start.txt');
  for (const text of [skill, start]) {
    assert.match(text, /\.xlsx up to 100MB/);
    assert.match(text, /\.xls up to 100MB/);
    assert.match(text, /\.csv up to 200MB/);
    assert.match(text, /same on every plan/);
    assert.doesNotMatch(text, /20\s?MB/i);
    assert.doesNotMatch(text, /free tier/i);
  }
  const gen = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'plugin', 'generate-session-start.js'), '--check'], { encoding: 'utf8' });
  assert.equal(gen.status, 0, `session-start.txt is what the generator makes: ${gen.stdout}${gen.stderr}`);
});

test('plugin text: "20MB on the free tier" and "Free tier" tool wording are gone from the repo (history files and fixtures excepted)', () => {
  const skip = (p) => /CHANGELOG\.md$|mcp-registry-xlsx-for-ai-2026-07-15\.json$|front-door-package\.test\.js$/.test(p);
  const files = [...walkJs(ROOT), path.join(ROOT, 'README.md'), path.join(ROOT, 'server.json'),
    path.join(ROOT, 'claude-code-plugin', 'hooks', 'session-start.txt'),
    path.join(ROOT, 'claude-code-plugin', 'skills', 'spreadsheets', 'SKILL.md')];
  for (const f of files) {
    if (skip(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /20\s?MB on the free tier/i, f);
    assert.doesNotMatch(text, /Free tier\s*[—-]/, `${f}: the old tool-description lead`);
  }
});

// ---------------------------------------------------------------------------
// B1-12: one meaning of "signed in"
// ---------------------------------------------------------------------------

test('B1-12: a config with a key and no client_id counts as signed in everywhere, and the request sends that key', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ api_key: API_KEY }));
    await inProcess(stub, cfg, {}, async () => {
      delete process.env.XLSX_FOR_AI_KEY;
      const config = require('../../lib/config');
      assert.equal(config.hasStoredKey(), true);
      assert.equal(config.apiKey(), API_KEY);
      const { post: clientPost } = require('../../lib/client');
      const out = await clientPost('/api/v1/tools/xlsx_list_sheets', { file_b64: 'AA==' });
      assert.match(JSON.stringify(out), /STUB TOOL RESULT/);
      assert.equal(stub.state.unauthorizedToolCalls, 0, 'the key went out as the Bearer');
    });
    // The terminal command: no sign-in is started, and `login` says already signed in.
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.state.deviceRequests, 0);
    const l = await runCli(['login'], baseEnv(stub, cfg));
    assert.match(l.stdout + l.stderr, /Already signed in/);
    assert.equal(stub.state.deviceRequests, 0);
  });
});

test('B1-12: the MCP server answers with the tool result, not a sign-in link, for a key with no client_id', async () => {
  await withMcp(async ({ mcp, stub }) => {
    assert.equal(textOf(await mcp.call()), 'STUB TOOL RESULT: sheets = [Sheet1]');
    assert.equal(stub.state.deviceRequests, 0);
  }, { setup: ({ cfg }) => fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ api_key: API_KEY })) });
});

// ---------------------------------------------------------------------------
// B1-20: file size limits match the server
// ---------------------------------------------------------------------------

test('B1-20: limits per type match the server, and the sentence has the size, the limit and "no plan changes it"', () => {
  const rf = require('../../lib/read-file');
  const saved = process.env.XFA_MAX_FILE_MB;
  delete process.env.XFA_MAX_FILE_MB;
  try {
    assert.deepEqual(rf.SIZE_LIMITS_MB, { '.xlsx': 100, '.xlsm': 100, '.xls': 100, '.csv': 200 });
    const s = rf.fileTooLargeSentence({ sizeMB: 120.4, limitMB: 100, ext: '.xlsx' });
    assert.match(s, /120\.4 MB/);
    assert.match(s, /100 MB limit for \.xlsx files/);
    assert.match(s, /same on every plan/);
    assert.match(s, /\.csv \(up to 200 MB\)/);
    assert.doesNotMatch(s, /XFA_MAX_FILE_MB|environment variable|setting/);
    const env = rf.fileTooLargeSentence({ sizeMB: 12, limitMB: 10, ext: '.ods', limitFromEnv: true });
    assert.match(env, /XFA_MAX_FILE_MB/, 'the variable is named only when the person set it');
  } finally {
    if (saved !== undefined) process.env.XFA_MAX_FILE_MB = saved;
  }
});

test('B1-20: real mcp.js, a 60 MB .xlsx goes through to the server (the old local cap was 50 MB)', async () => {
  await withMcp(async ({ mcp, cfg, stub }) => {
    const big = path.join(cfg, 'big.xlsx');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 60 * 1024 * 1024);
    const out = textOf(await mcp.call(big));
    assert.equal(out, 'STUB TOOL RESULT: sheets = [Sheet1]');
    assert.equal(stub.state.toolCalls.length, 1, 'the request reached the server');
    assert.doesNotMatch(out, /XFA_MAX_FILE_MB/);
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

test('B1-20: real mcp.js, over the limit: usable sentence with no variable name; each type has its own limit', async () => {
  await withMcp(async ({ mcp, cfg, stub }) => {
    const mk = (name, mb) => {
      const f = path.join(cfg, name);
      fs.closeSync(fs.openSync(f, 'w'));
      fs.truncateSync(f, mb * 1024 * 1024);
      return f;
    };
    const x = await mcp.call(mk('over.xlsx', 101));
    assert.equal(x.isError, true);
    assert.match(textOf(x), /over the 100 MB limit for \.xlsx files/);
    assert.match(textOf(x), /same on every plan/);
    assert.doesNotMatch(textOf(x), /XFA_MAX_FILE_MB/);
    const c = await mcp.call(mk('over.csv', 201));
    assert.match(textOf(c), /over the 200 MB limit for \.csv files/);
    const o = await mcp.call(mk('over.tsv', 11));
    assert.match(textOf(o), /over the 10 MB limit for \.tsv files/);
    assert.equal(stub.state.toolCalls.length, 0, 'nothing over its limit was sent');
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

// ---------------------------------------------------------------------------
// B1-24: a server-only tool and the generic failure text
// ---------------------------------------------------------------------------

test('B1-24: a tool the server lists that takes no file is relayed as given and answers with a usable sentence', async () => {
  await withStub(async ({ stub, cfg }) => {
    await post(stub, '/__config', { catalog: [{ name: 'server_only_ping', description: 'No file.', inputSchema: { type: 'object', properties: { topic: { type: 'string' } } } }] });
    await inProcess(stub, cfg, {}, async () => {
      const { dispatchTool } = require('../../mcp');
      const result = await dispatchTool('server_only_ping', { topic: 'hello' });
      assert.match(JSON.stringify(result), /STUB TOOL RESULT/);
    });
    assert.equal(stub.state.toolBodies.length, 1);
    assert.equal(stub.state.toolBodies[0].topic, 'hello', 'the arguments went out as given');
    assert.equal('file_b64' in stub.state.toolBodies[0], false, 'no made-up file');
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

test('B1-24: the generic failure text is a sentence a person can act on, with no "server-side logs"', () => {
  const { friendlyErrorMessage } = require('../../mcp');
  const s = friendlyErrorMessage('some_tool', new Error('boom at /Users/x/secret.js:1'));
  assert.doesNotMatch(s, /server-side logs|request_id/);
  assert.doesNotMatch(s, /\/Users\/x|boom/, 'no internals');
  assert.match(s, /try the same request again/i);
  assert.match(s, /restart this app/i);
  assert.match(s, /github\.com\/senoff\/xlsx-for-ai\/issues/);
});

// ---------------------------------------------------------------------------
// B1-27 / B5-3: the notice for keys that will stop reaches the person
// ---------------------------------------------------------------------------

const SUNSET_HEADERS = {
  Sunset: 'Fri, 06 Nov 2026 00:00:00 GMT',
  'X-XFA-Notice': 'Keys made before sign-in stop on 2026-11-06. Run npm i -g xlsx-for-ai@latest and xlsx-for-ai login.',
};

test('B1-27: MCP, the service marks the response: the tool result carries a notice, once, with no date and no terminal step', async () => {
  await withMcp(async ({ mcp }) => {
    const first = await mcp.call();
    assert.notEqual(first.isError, true);
    const out = textOf(first);
    assert.match(out, /^STUB TOOL RESULT/, 'the real answer is first and untouched');
    assert.match(out, /older kind of key/);
    assert.match(out, /sign-in link \(sign in with Google\) will appear right here/);
    assert.doesNotMatch(out, /2026|November|Nov |npm|terminal|xlsx-for-ai login/, 'no date, no terminal step, not the service text repeated');
    assert.doesNotMatch(textOf(await mcp.call()), /older kind of key/, 'shown once per run');
  }, { setup: async ({ stub, cfg }) => { storeKey(cfg, API_KEY); await post(stub, '/__config', { toolHeaders: SUNSET_HEADERS }); } });
});

test('B1-27: terminal, the service marks the response: one line on stderr with the one command that switches now; stdout stays the answer', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'STUB TOOL RESULT: sheets = [Sheet1]');
    assert.match(r.stderr, /older kind of key/);
    assert.match(r.stderr, /`xlsx-for-ai login --force`/);
    assert.doesNotMatch(r.stderr, /2026|November|npm i/);
  }, { setup: async ({ stub, cfg }) => { storeKey(cfg, API_KEY); await post(stub, '/__config', { toolHeaders: SUNSET_HEADERS }); } });
});

test('B1-27: no mark from the service, no notice (a plain answer is left alone)', async () => {
  await withMcp(async ({ mcp }) => {
    assert.equal(textOf(await mcp.call()), 'STUB TOOL RESULT: sheets = [Sheet1]');
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

test('B5-3: the notice the package shows names a step the person can take where they are, and promises no date', () => {
  const { SUNSET_NOTICE_MCP, SUNSET_NOTICE_CLI } = require('../../lib/notices');
  assert.doesNotMatch(SUNSET_NOTICE_MCP, /20\d\d|January|February|March|April|May |June|July|August|September|October|November|December/);
  assert.doesNotMatch(SUNSET_NOTICE_CLI, /20\d\d|November/);
  assert.doesNotMatch(SUNSET_NOTICE_MCP, /terminal|npm|run /i, 'an app person is not sent to a terminal');
  assert.match(SUNSET_NOTICE_MCP, /Google/);
  assert.match(SUNSET_NOTICE_CLI, /login --force/);
});

// ---------------------------------------------------------------------------
// B2-8: an automated run with no key
// ---------------------------------------------------------------------------

test('B2-8: terminal, CI=true and no key: says a key is needed and how to provide it (XLSX_FOR_AI_KEY)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg, { CI: 'true' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /automated run, and it has no key/);
    assert.match(r.stderr, /XLSX_FOR_AI_KEY/);
    assert.match(r.stderr, /~\/\.xlsx-for-ai\/config\.json/);
    assert.equal(stub.state.deviceRequests, 0, 'no sign-in is started');
    assert.doesNotMatch(r.stderr, /Invalid or missing API key/);
  }, { setup: () => {} });
});

test('B2-8: MCP, CI=true and no key: the same sentence in the tool result', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const mcp = await startMcp(baseEnv(stub, cfg, { CI: 'true' }), csv);
    try {
      const r = await mcp.call();
      assert.equal(r.isError, true);
      assert.match(textOf(r), /automated run, and it has no key/);
      assert.match(textOf(r), /XLSX_FOR_AI_KEY/);
    } finally { mcp.stop(); }
  });
});

test('B2-8: XLSX_FOR_AI_KEY supplies the key: the request goes out signed and succeeds, with nothing stored', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg, { CI: 'true', XLSX_FOR_AI_KEY: API_KEY }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /STUB TOOL RESULT/);
    assert.equal(stub.state.unauthorizedToolCalls, 0);
    assert.equal(hasKey(cfg), false, 'the key is not written to disk');
    const mcp = await startMcp(baseEnv(stub, cfg, { CI: 'true', XLSX_FOR_AI_KEY: API_KEY }), csv);
    try {
      assert.equal(textOf(await mcp.call()), 'STUB TOOL RESULT: sheets = [Sheet1]');
    } finally { mcp.stop(); }
  });
});

// ---------------------------------------------------------------------------
// B3-5 / B3-6: updates
// ---------------------------------------------------------------------------

test('B3-5: a 4.2.0 copy in a writable place updates itself on one launch, and the next launch shows the sign-in link', async (t) => {
  const old = oldCopy('v4.2.0');
  if (!old) { t.skip('the v4.2.0 tag is not in this clone'); return; }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-fakenpm-'));
  try {
    // A stand-in for `npm install -g xlsx-for-ai@latest`: lays this checkout's files over the old copy.
    const fake = path.join(bin, 'npm');
    fs.writeFileSync(fake, [
      '#!/usr/bin/env node',
      "const fs = require('fs'); const path = require('path');",
      "for (const e of ['package.json', 'index.js', 'mcp.js', 'lib', 'generated']) {",
      "  fs.cpSync(path.join(process.env.FAKE_NPM_SRC, e), path.join(process.env.FAKE_NPM_DEST, e), { recursive: true, force: true });",
      '}',
      "fs.writeFileSync(process.env.FAKE_NPM_MARKER, process.argv.slice(2).join(' '));",
      '',
    ].join('\n'), { mode: 0o755 });
    await withStub(async ({ stub, cfg, csv }) => {
      const marker = path.join(cfg, 'npm-ran.txt');
      const env = baseEnv(stub, cfg, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        XFA_LATEST_VERSION: '99.0.0',
        FAKE_NPM_SRC: ROOT, FAKE_NPM_DEST: old, FAKE_NPM_MARKER: marker,
      });
      delete env.XFA_NO_AUTO_UPDATE;
      const first = await startOldMcp(old, env, csv);
      try {
        assert.ok(await waitFor(() => fs.existsSync(marker), 20000), `npm was run; stderr: ${first.stderr()}`);
        assert.equal(fs.readFileSync(marker, 'utf8'), 'install -g xlsx-for-ai@latest');
      } finally { first.stop(); }
      assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'package.json'), 'utf8')).version, require('../../package.json').version, 'the files were replaced');
      const second = await startOldMcp(old, env, csv);
      try {
        const out = textOf(await second.call());
        assert.match(out, /oauth\/device\?user_code=STUB-0001/, 'the second launch runs the new code and shows the link');
      } finally { second.stop(); }
    });
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('B3-6: a copy that cannot update itself says so in the tool result, with the command and what to do', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    storeKey(cfg, API_KEY);
    // An empty install folder name: nowhere writable to update.
    const env = baseEnv(stub, cfg, { XFA_LATEST_VERSION: '99.0.0', XFA_INSTALL_ROOT: '' });
    delete env.XFA_NO_AUTO_UPDATE;
    const mcp = await startMcp(env, csv);
    try {
      const cache = path.join(cfg, 'upgrade-check.json');
      assert.ok(await waitFor(() => { try { return JSON.parse(fs.readFileSync(cache, 'utf8')).manual === true; } catch (_) { return false; } }, 15000), 'the check ran');
      const out = textOf(await mcp.call());
      assert.match(out, /^STUB TOOL RESULT/);
      assert.match(out, /newer xlsx-for-ai \(99\.0\.0\) is available/);
      assert.match(out, /could not update itself/);
      assert.match(out, /`npm install -g xlsx-for-ai@latest`/);
      assert.match(out, /restart this app/);
      assert.match(out, /assistant that can run commands/);
      assert.doesNotMatch(textOf(await mcp.call()), /newer xlsx-for-ai/, 'once per run');
    } finally { mcp.stop(); }
  });
});

test('B3-6: updateNotice is empty when current, when the copy can update itself, and before any check', async () => {
  await withStub(async ({ stub, cfg }) => {
    await inProcess(stub, cfg, {}, async () => {
      const { updateNotice } = require('../../lib/auto-upgrade');
      const file = path.join(cfg, 'upgrade-check.json');
      assert.equal(updateNotice('4.2.3'), '', 'no check yet');
      fs.writeFileSync(file, JSON.stringify({ latest: '9.0.0', manual: false }));
      assert.equal(updateNotice('4.2.3'), '', 'it can update itself');
      fs.writeFileSync(file, JSON.stringify({ latest: '4.2.3', manual: true }));
      assert.equal(updateNotice('4.2.3'), '', 'already the newest');
      fs.writeFileSync(file, JSON.stringify({ latest: '9.0.0', manual: true }));
      assert.match(updateNotice('4.2.3'), /9\.0\.0.*4\.2\.3/);
    });
  });
});

test('B3-6: the terminal command checks for a newer version only where a person is looking (a terminal on stderr)', () => {
  const src = codeLines(readText('index.js')).join('\n');
  assert.match(src, /process\.stderr\.isTTY[\s\S]{0,200}checkForUpgrade\(\{[^}]*noticeOnly: true/);
});

// ---------------------------------------------------------------------------
// B5: people on older versions
// ---------------------------------------------------------------------------

test('B5-1: a 4.0.x copy with a stored key keeps working against the service', async (t) => {
  const old = oldCopy('v4.0.10');
  if (!old) { t.skip('the v4.0.10 tag is not in this clone'); return; }
  try {
    await withStub(async ({ stub, cfg, csv }) => {
      const r = await runOldCli(old, [csv], baseEnv(stub, cfg));
      assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /STUB TOOL RESULT/);
    }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});

test('B5-2: a brand-new 4.0.x copy with no key: what it does today is pinned (it asks the service for a key with no account)', async (t) => {
  const old = oldCopy('v4.0.10');
  if (!old) { t.skip('the v4.0.10 tag is not in this clone'); return; }
  try {
    const reg = require('node:child_process').spawnSync('git', ['-C', ROOT, 'show', 'v4.0.10:lib/register.js'], { encoding: 'utf8' }).stdout;
    assert.match(reg, /\/api\/v1\/clients/);
    assert.doesNotMatch(reg, /oauth\/device|deviceLogin/i, '4.0.x has no sign-in code to fall back on');
    await withStub(async ({ stub, cfg, csv }) => {
      const r = await runOldCli(old, [csv], baseEnv(stub, cfg));
      assert.notEqual(r.code, 0, 'the stand-in refuses an account-less key request, as the live service does when it requires sign-in');
      assert.ok(`${r.stdout}${r.stderr}`.trim().length > 0, 'it prints something, not silence');
    });
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});

test('B5-4: with a stored key the service turns down, this version moves the person to sign-in where they are (MCP: link on the same request; terminal: the exact command)', async () => {
  await withMcp(async ({ mcp, cfg }) => {
    const out = textOf(await mcp.call());
    assert.match(out, /not accepted/i);
    assert.match(out, /oauth\/device\?user_code=STUB-0001/);
    assert.equal(readCfg(cfg).api_key, 'xfa_old_key');
  }, { setup: ({ cfg }) => storeKey(cfg, 'xfa_old_key') });
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.match(r.stderr, /`xlsx-for-ai login --force`/);
  }, { setup: ({ cfg }) => storeKey(cfg, 'xfa_old_key') });
});

test('B5-5: a 4.2.0 copy in a host with no key stays at the service\'s 401 text (the fix reaches it through the update in B3-5); this version shows the link', async (t) => {
  const old = oldCopy('v4.2.0');
  if (!old) { t.skip('the v4.2.0 tag is not in this clone'); return; }
  try {
    await withStub(async ({ stub, cfg, csv }) => {
      const m = await startOldMcp(old, baseEnv(stub, cfg), csv);
      try {
        const r = await m.call();
        const out = (r.content || []).map((c) => c.text).join('\n');
        assert.doesNotMatch(out, /oauth\/device/, 'the old copy shows no sign-in link');
        assert.match(out, /Invalid or missing API key|API key|sign/i);
      } finally { m.stop(); }
      const cur = await startMcp(baseEnv(stub, cfg), csv);
      try {
        assert.match(textOf(await cur.call()), /oauth\/device\?user_code=/);
      } finally { cur.stop(); }
    });
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});

test('B5-6: the exact words a 4.2.0 person sees with no key in a host are the service\'s 401 text, with no update step', async (t) => {
  const old = oldCopy('v4.2.0');
  if (!old) { t.skip('the v4.2.0 tag is not in this clone'); return; }
  try {
    await withStub(async ({ stub, cfg, csv }) => {
      const m = await startOldMcp(old, baseEnv(stub, cfg), csv);
      try {
        const r = await m.call();
        const out = (r.content || []).map((c) => c.text).join('\n');
        assert.match(out, /Invalid or missing API key/);
        assert.doesNotMatch(out, /update|npm/i, 'the service sends nothing version-specific today (a server-side fix, see the PR notes)');
      } finally { m.stop(); }
    });
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});

test('B5-7: 4.1.0 and 4.2.0 run the device sign-in when a terminal is attached (their register code, read from the tags)', (t) => {
  for (const tag of ['v4.1.0', 'v4.2.0']) {
    const r = require('node:child_process').spawnSync('git', ['-C', ROOT, 'show', `${tag}:lib/register.js`], { encoding: 'utf8' });
    if (r.status !== 0) { t.skip(`the ${tag} tag is not in this clone`); return; }
    assert.match(r.stdout, /isInteractive/, tag);
    assert.match(r.stdout, /deviceLogin|login/i, tag);
  }
});

test('B5-8: a 4.2.0 terminal command with no key and no terminal ends with a message and no link (pinned); this version waits and shows the link', async (t) => {
  const old = oldCopy('v4.2.0');
  if (!old) { t.skip('the v4.2.0 tag is not in this clone'); return; }
  try {
    await withStub(async ({ stub, cfg, csv }) => {
      const r = await runOldCli(old, [csv], baseEnv(stub, cfg));
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.stderr, /oauth\/device\?user_code=/);
      const now = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
      assert.match(now.stderr, /oauth\/device\?user_code=STUB-/);
      assert.match(now.stderr, /run the same command again/i);
    });
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});

test('B5-9: a 3.0.16 bundle: its tag exists, and what it needs from the service is not something this package can change', (t) => {
  const r = require('node:child_process').spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', 'refs/tags/v3.0.16']);
  if (r.status !== 0) { t.skip('the v3.0.16 tag is not in this clone'); return; }
  const pkg = JSON.parse(require('node:child_process').spawnSync('git', ['-C', ROOT, 'show', 'v3.0.16:package.json'], { encoding: 'utf8' }).stdout);
  assert.match(pkg.version, /^3\.0\.16$/);
});

// ---------------------------------------------------------------------------
// 501: its own exit code and words
// ---------------------------------------------------------------------------

test('501: the terminal command exits 5 and says the function is not built yet and nothing is wrong with the file', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /This function is not built yet\. Nothing is wrong with your file, and trying again will not help\./);
    assert.match(r.stderr, /XLOOKUP2 is not built yet/);
    assert.doesNotMatch(r.stderr, /retry shortly|server error/i);
  }, { setup: SCRIPTED(501, GAP_501) });
});

test('501: the other exit codes are unchanged (500 is 3, a 400 is 1, a link is 4)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { toolResponse: { status: 500, body: { error: { message: 'x' } } } });
    assert.equal((await runCli([csv], baseEnv(stub, cfg))).code, 3);
    await post(stub, '/__config', { toolResponse: { status: 400, body: { error: { code: 'bad_request', message: 'Bad input.' } } } });
    assert.equal((await runCli([csv], baseEnv(stub, cfg))).code, 1);
    assert.equal((await runCli([LINKS[0]], baseEnv(stub, cfg))).code, 4);
  }, { setup: ({ cfg }) => storeKey(cfg, API_KEY) });
});

test('501: MCP says the same, and a bare "Not Implemented" is not repeated', async () => {
  await withMcp(async ({ mcp }) => {
    assert.match(textOf(await mcp.call()), /This function is not built yet\. Nothing is wrong with your file/);
  }, { setup: SCRIPTED(501, { error: { code: 'not_implemented', message: 'Not Implemented' } }) });
});

test('501: the README documents exit code 5', () => {
  assert.match(readText('README.md'), /exits with code 5/);
});

// ---------------------------------------------------------------------------
// Batch-1 review leftovers
// ---------------------------------------------------------------------------

test('4a: dropPendingRequest takes only its own request: matching is removed, a newer one survives, an even newer one wins, nothing is left behind', async () => {
  await withStub(async ({ stub, cfg }) => {
    await inProcess(stub, cfg, {}, async () => {
      const login = require('../../lib/login');
      const mk = (id) => ({ clientId: 'c', resource: 'r', deviceCode: `DEV-${id}`, userCode: id, verificationUri: 'u', verificationUriComplete: 'u?c', interval: 1, expiresIn: 900 });
      const file = login.pendingPath();
      assert.equal(login.savePendingRequest(mk('A')), true);
      login.dropPendingRequest(mk('A'));
      assert.equal(fs.existsSync(file), false, 'its own request is removed');

      login.savePendingRequest(mk('B'));
      login.dropPendingRequest(mk('A'));
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).userCode, 'B', 'a newer request from another command survives');

      // Between the claim and the put-back, a still newer request is saved: it must win.
      login.dropPendingRequest(mk('A'), { beforeRestore: () => login.savePendingRequest(mk('C')) });
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).userCode, 'C', 'the newest request wins');

      login.dropPendingRequest(null);
      assert.equal(fs.existsSync(file), false);
      assert.deepEqual(fs.readdirSync(cfg).filter((f) => /pending-login/.test(f)), [], 'no claim or temp file is left');
    });
  });
});

test('4b: two sign-ins approved together end with the SAME key: the first key saved wins, and both callers get it', async () => {
  await withStub(async ({ stub, cfg }) => {
    // The first key request is slow; the second answers at once, so it is saved first.
    await post(stub, '/__config', { distinctKeys: true, clientsDelayMsByCall: [700, 0] });
    await inProcess(stub, cfg, {}, async () => {
      const login = require('../../lib/login');
      const a = await login.startDeviceRequest();
      const b = await login.startDeviceRequest();
      await post(stub, '/__approve');
      const fast = { sleep: () => Promise.resolve() };
      const [ra, rb] = await Promise.all([login.pollDeviceLogin(a, fast), login.pollDeviceLogin(b, fast)]);
      assert.equal(ra.api_key, rb.api_key, 'both callers end with one key');
      assert.equal(readCfg(cfg).api_key, ra.api_key, 'and it is the one on disk');
      assert.equal(ra.api_key, `${API_KEY}_2`, 'the one saved first (the quicker answer) wins');
      assert.equal(stub.state.clientsCalls <= 2, true);
    });
    assert.deepEqual(leftovers(cfg), []);
  });
});

test('4b: a sign-in that finds another already saved a key uses it and asks for none', async () => {
  await withStub(async ({ stub, cfg }) => {
    await inProcess(stub, cfg, {}, async () => {
      const login = require('../../lib/login');
      const a = await login.startDeviceRequest();
      await post(stub, '/__approve');
      // Another command saves its key while this one is waiting for the approval to be picked up.
      const otherSaves = async () => { fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ client_id: 'other', api_key: 'xfa_saved_by_other' })); };
      const r = await login.pollDeviceLogin(a, { sleep: otherSaves });
      assert.equal(r.api_key, 'xfa_saved_by_other');
      assert.equal(stub.state.clientsCalls, 0, 'no second key was asked for');
    });
  });
});

test('4c: a 4xx from client registration says the service turned the request down, not "unreachable" (terminal and MCP)', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /turned down the request to register this command \(HTTP 403\)/);
    assert.match(r.stderr, /Trying again will not change that/);
    assert.match(r.stderr, /github\.com\/senoff\/xlsx-for-ai\/issues/);
    assert.doesNotMatch(r.stderr, /unreachable|did not answer|could not be reached/i);
    const mcp = await startMcp(baseEnv(stub, cfg), csv);
    try {
      const m = await mcp.call();
      assert.equal(m.isError, true);
      assert.match(textOf(m), /turned down the request/);
      assert.match(textOf(m), /Update xlsx-for-ai/);
      assert.doesNotMatch(textOf(m), /did not answer|try again in a minute/i);
    } finally { mcp.stop(); }
  }, { setup: async ({ stub }) => { await post(stub, '/__config', { regStatus: 403 }); } });
});

test('4c: a 5xx from client registration is still "try again in a minute"', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    await post(stub, '/__config', { regFailTimes: 99 });
    const r = await runCli([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '0' }));
    assert.match(r.stderr, /could not register this command \(HTTP 503\)\. Try again in a minute\./);
  });
});

test('4d: a stderr that cannot be written (decision: swallow on purpose) still lets a sign-in finish', async () => {
  const pre = throwingStderrPreload();
  try {
    await withStub(async ({ stub, cfg, csv }) => {
      const run = runCliWith([csv], baseEnv(stub, cfg, { XFA_LOGIN_WAIT_SECONDS: '20' }), ['-r', pre.file]);
      assert.ok(await waitFor(() => stub.state.deviceRequests === 1), 'a sign-in was started');
      await post(stub, '/__approve');
      const r = await run;
      assert.equal(r.code, 0, `exit 0: ${r.stdout}`);
      assert.match(r.stdout, /STUB TOOL RESULT/);
      assert.equal(readCfg(cfg).api_key, API_KEY);
    });
  } finally { fs.rmSync(pre.dir, { recursive: true, force: true }); }
});

test('4d: stderrLine reports whether the line was written, and never throws', () => {
  const { stderrLine } = require('../../lib/login');
  const real = process.stderr.write;
  try {
    process.stderr.write = () => { throw new Error('closed'); };
    assert.equal(stderrLine('x'), false);
    let wrote = '';
    process.stderr.write = (s) => { wrote += s; return true; };
    assert.equal(stderrLine('hello'), true);
    assert.equal(wrote, 'hello\n');
  } finally { process.stderr.write = real; }
  assert.match(readText('lib', 'login.js'), /swallow[\s\S]{0,400}on purpose|on purpose[\s\S]{0,400}swallow/i, 'the decision is written in a comment');
});

test('4e: every place that reads XFA_DEBUG passes what it prints through scrubSensitive', async () => {
  const sites = [];
  for (const f of [path.join(ROOT, 'index.js'), path.join(ROOT, 'mcp.js'), ...walkJs(path.join(ROOT, 'lib'))]) {
    const lines = codeLines(fs.readFileSync(f, 'utf8'));
    lines.forEach((l, i) => { if (/XFA_DEBUG/.test(l)) sites.push({ f: path.relative(ROOT, f), l, near: lines.slice(Math.max(0, i - 2), i + 45).join('\n') }); });
  }
  assert.equal(sites.length, 1, `exactly one reader: ${JSON.stringify(sites.map((s) => s.f))}`);
  assert.equal(sites[0].f, 'index.js');
  assert.match(sites[0].near, /showRaw && err \? scrubSensitive\(err\.message\)/);
  // And it behaves that way on a command other than the plain read.
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli(['heal', csv], baseEnv(stub, cfg, { XFA_DEBUG: '1' }));
    assert.doesNotMatch(r.stderr, /person@example\.com|abcdefghijklmnop123456/);
    assert.match(r.stderr, /^Raw: .*<email>/m);
  }, { setup: SCRIPTED(400, { error: { code: 'bad_request', message: 'Bad input from person@example.com using Bearer abcdefghijklmnop123456' } }) });
});

test('4f: a pasted link exits 4 even when every write to stderr throws (ran red on the pre-fix code: exit 1; the older closed-pipe test passed on both)', async () => {
  const pre = throwingStderrPreload();
  try {
    await withStub(async ({ stub, cfg }) => {
      for (const args of [[LINKS[0]], ['heal', LINKS[0]], ['stamp', LINKS[0]]]) {
        const r = await runCliWith(args, baseEnv(stub, cfg), ['-r', pre.file]);
        assert.equal(r.code, 4, `${args[0]}: ${r.stdout}`);
      }
    });
  } finally { fs.rmSync(pre.dir, { recursive: true, force: true }); }
});

test('4g: the README names pending-login.json where it describes saved state', () => {
  const readme = readText('README.md');
  const config = readme.slice(readme.indexOf('## Config'));
  assert.match(config, /pending-login\.json/);
});

test('4h: scripts/__pycache__/ is ignored by git', () => {
  assert.ok(readText('.gitignore').split('\n').includes('scripts/__pycache__/'));
});

// ---------------------------------------------------------------------------
// Pricing words
// ---------------------------------------------------------------------------

test('pricing: README, plugin text, messages and this release\'s changelog entry say only the ruled words, and promise no sign-in cutoff date', () => {
  const changelog = readText('CHANGELOG.md');
  const entry = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('## [4.2.2]'));
  const readme = readText('README.md');
  assert.match(readme, /first 1,000 people to register get 500 files a month free\. Everyone after gets 10 free files, then \$25 a year for 10,000 files a month\. Sign-in is with Google\./);
  const sources = [
    ['README.md', readme], ['CHANGELOG 4.2.3 entry', entry],
    ['SKILL.md', readText('claude-code-plugin', 'skills', 'spreadsheets', 'SKILL.md')],
    ['session-start.txt', readText('claude-code-plugin', 'hooks', 'session-start.txt')],
    ['index.js', codeLines(readText('index.js')).join('\n')],
    ['mcp.js', codeLines(readText('mcp.js')).join('\n')],
    ...walkJs(path.join(ROOT, 'lib')).map((f) => [path.relative(ROOT, f), codeLines(fs.readFileSync(f, 'utf8')).join('\n')]),
  ];
  for (const [name, text] of sources) {
    assert.doesNotMatch(text, /free tier/i, `${name}: no "free tier"`);
    assert.doesNotMatch(text, /first 1,000 people to sign in/i, `${name}: register, not sign in`);
    assert.doesNotMatch(text, /\$\s?\d+\s*(a|per|\/)\s*month/i, `${name}: no monthly price`);
    assert.doesNotMatch(text, /2026-11-06|November 6|Nov(ember)? 6\b/, `${name}: no sign-in cutoff date`);
    assert.doesNotMatch(text, /until the cutoff/i, `${name}`);
  }
});
