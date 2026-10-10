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
