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
    assert.equal(readCfg(cfg).pending_login, undefined, 'the saved request is dropped once used');
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
    assert.ok(readCfg(cfg).pending_login, 'the pending request is saved for the rerun');
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
    assert.equal(readCfg(cfg).pending_login, undefined);
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
    assert.equal(readCfg(cfg).pending_login.userCode, 'STUB-0002');

    // A saved request whose time is already up is dropped without asking the service.
    const c = readCfg(cfg);
    c.pending_login.expiresAtMs = Date.now() - 1000;
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify(c));
    const third = await runCli([csv], env);
    assert.notEqual(third.code, 0);
    assert.match(third.stderr, /STUB-0003/);
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
    assert.match(out, /https:\/\/xlsx-for-ai\.dev\/upgrade\?from=test/);
    assert.doesNotMatch(out, /capture mode/);
  }, { setup: SCRIPTED(402, PAYWALL_402) });
});

test('B2-9: terminal, free files used up: the server\'s sentence and its upgrade link are shown', async () => {
  await withStub(async ({ stub, cfg, csv }) => {
    const r = await runCli([csv], baseEnv(stub, cfg));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /You have used your 500 free files this month\./);
    assert.match(r.stderr, /https:\/\/xlsx-for-ai\.dev\/upgrade\?from=test/);
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
