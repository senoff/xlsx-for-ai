'use strict';

// XLS-264: `xfa feedback` and `xfa support`. Two guarantees pinned here:
//
// 1. Client-side validation rejects an empty message / missing-or-malformed
//    email / missing question BEFORE any network call (the DoD's "rejected
//    client-side" clause). We assert the injected post() was never called.
// 2. A valid submission posts the right body to the right path, unauthenticated
//    (auth:false), with the internal tag header only when XFA_INTERNAL=1, and
//    prints the spec's confirmation line + exits 0.
//
// post() and ensureRegistered() are injected, so the suite runs with no network
// and passes in CI (unlike the live-API cli-subcommands suite).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  runFeedbackSubcommand,
  runSupportSubcommand,
  validateFeedbackArgs,
  validateSupportArgs,
  MAX_MESSAGE_CHARS,
  MAX_QUESTION_CHARS,
} = require('../../lib/feedback');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

// A deps harness: records post() calls and captures out/err, never touches the
// network.
function harness(overrides = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const deps = {
    post: async (path, body, opts) => { calls.push({ path, body, opts }); return { ok: true }; },
    getClientId: async () => CLIENT_ID,
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    ...overrides,
  };
  return { deps, calls, out, err };
}

// ---- pure validators -----------------------------------------------------

test('validateFeedbackArgs: rejects empty / whitespace, accepts real text', () => {
  assert.equal(validateFeedbackArgs([]).ok, false);
  assert.equal(validateFeedbackArgs(['   ']).ok, false);
  const v = validateFeedbackArgs(['love', 'the', 'diff', 'tool']);
  assert.equal(v.ok, true);
  assert.equal(v.message, 'love the diff tool');
});

test('validateSupportArgs: needs a valid email AND a question', () => {
  assert.equal(validateSupportArgs([]).ok, false, 'no email');
  assert.equal(validateSupportArgs(['not-an-email', 'help']).ok, false, 'malformed email');
  assert.equal(validateSupportArgs(['me@example.com']).ok, false, 'no question');
  const v = validateSupportArgs(['me@example.com', 'how', 'do', 'I', 'diff?']);
  assert.equal(v.ok, true);
  assert.equal(v.email, 'me@example.com');
  assert.equal(v.question, 'how do I diff?');
});

test('validators reject over-length message / question client-side', () => {
  const longMsg = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
  assert.equal(validateFeedbackArgs([longMsg]).ok, false, 'over-cap message rejected');
  const longQ = 'y'.repeat(MAX_QUESTION_CHARS + 1);
  assert.equal(validateSupportArgs(['me@example.com', longQ]).ok, false, 'over-cap question rejected');
});

// ---- feedback subcommand -------------------------------------------------

test('feedback: valid message posts to /feedback and confirms, exit 0', async () => {
  const { deps, calls, out } = harness();
  const code = await runFeedbackSubcommand(['great', 'tool'], deps);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/feedback');
  assert.deepEqual(calls[0].body, { client_id: CLIENT_ID, message: 'great tool' });
  assert.equal(calls[0].opts.auth, false, 'anonymous — no auth');
  assert.ok(out.join('').includes('feedback was sent'));
});

test('feedback: empty message is rejected client-side, no network', async () => {
  const { deps, calls, err } = harness();
  const code = await runFeedbackSubcommand([], deps);
  assert.equal(code, 2, 'usage error exits 2');
  assert.equal(calls.length, 0, 'must NOT post on invalid input');
  assert.ok(err.join('').includes('Usage: xfa feedback'));
});

test('feedback: XFA_INTERNAL=1 adds the internal tag header', async () => {
  const prev = process.env.XFA_INTERNAL;
  process.env.XFA_INTERNAL = '1';
  try {
    const { deps, calls } = harness();
    await runFeedbackSubcommand(['internal check'], deps);
    assert.equal(calls[0].opts.headers['X-XFA-Internal'], '1');
  } finally {
    if (prev === undefined) delete process.env.XFA_INTERNAL; else process.env.XFA_INTERNAL = prev;
  }
});

test('feedback: no internal header when XFA_INTERNAL is unset', async () => {
  const prev = process.env.XFA_INTERNAL;
  delete process.env.XFA_INTERNAL;
  try {
    const { deps, calls } = harness();
    await runFeedbackSubcommand(['normal user'], deps);
    assert.ok(!calls[0].opts.headers, 'no headers object when not internal');
  } finally {
    if (prev !== undefined) process.env.XFA_INTERNAL = prev;
  }
});

// ---- support subcommand --------------------------------------------------

test('support: valid email + question posts to /support and confirms, exit 0', async () => {
  const { deps, calls, out } = harness();
  const code = await runSupportSubcommand(['me@example.com', 'why', 'no', 'sheet?'], deps);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/support');
  assert.deepEqual(calls[0].body, {
    client_id: CLIENT_ID,
    email: 'me@example.com',
    question: 'why no sheet?',
  });
  assert.equal(calls[0].opts.auth, false);
  assert.ok(out.join('').includes("we'll reply to me@example.com"), 'confirm names the reply-to email');
});

test('support: malformed email is rejected client-side, no network', async () => {
  const { deps, calls, err } = harness();
  const code = await runSupportSubcommand(['nope', 'my question'], deps);
  assert.equal(code, 2);
  assert.equal(calls.length, 0, 'must NOT post on a bad email');
  assert.ok(err.join('').includes('valid email'));
});

test('support: missing question is rejected client-side, no network', async () => {
  const { deps, calls } = harness();
  const code = await runSupportSubcommand(['me@example.com'], deps);
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test('support: XFA_INTERNAL=1 adds the internal tag header (parity with feedback)', async () => {
  const prev = process.env.XFA_INTERNAL;
  process.env.XFA_INTERNAL = '1';
  try {
    const { deps, calls } = harness();
    await runSupportSubcommand(['me@example.com', 'a question'], deps);
    assert.equal(calls[0].opts.headers['X-XFA-Internal'], '1');
  } finally {
    if (prev === undefined) delete process.env.XFA_INTERNAL; else process.env.XFA_INTERNAL = prev;
  }
});

// ---- network failure surfaces a friendly non-zero exit -------------------

test('feedback: a post() failure exits 1 with a friendly message', async () => {
  const { deps, out, err } = harness({
    post: async () => { const e = new Error('API unreachable'); throw e; },
  });
  const code = await runFeedbackSubcommand(['hi'], deps);
  assert.equal(code, 1);
  assert.equal(out.length, 0, 'no success confirmation on failure');
  assert.ok(err.join('').includes("Couldn't send your feedback"));
});

test('feedback: a client-id failure exits 1 before any post', async () => {
  const { deps, calls, err } = harness({
    getClientId: async () => { throw new Error('boom'); },
  });
  const code = await runFeedbackSubcommand(['hi'], deps);
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
  assert.ok(err.join('').includes('client id'));
});

test('feedback: a non-UUID client_id exits 1 before any post (server would 400)', async () => {
  for (const bad of [undefined, '', 'not-a-uuid']) {
    const { deps, calls, err } = harness({ getClientId: async () => bad });
    const code = await runFeedbackSubcommand(['hi'], deps);
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.ok(err.join('').includes('client id'));
  }
});

test('default client id: valid UUID, stable across calls, no login required', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-fb-'));
  const prev = process.env.XFA_CONFIG_DIR;
  process.env.XFA_CONFIG_DIR = dir;
  try {
    const { resolveClientId } = require('../../lib/feedback');
    const a = resolveClientId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(resolveClientId(), a, 'persisted and reused');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).client_id, a);
  } finally {
    if (prev === undefined) delete process.env.XFA_CONFIG_DIR; else process.env.XFA_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default client id: a malformed stored client_id is replaced, not sent', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-fb-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ client_id: 'junk', api_key: 'k' }));
  const prev = process.env.XFA_CONFIG_DIR;
  process.env.XFA_CONFIG_DIR = dir;
  try {
    const { resolveClientId } = require('../../lib/feedback');
    const id = resolveClientId();
    assert.notEqual(id, 'junk');
    assert.match(id, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).api_key, 'k', 'other keys kept');
  } finally {
    if (prev === undefined) delete process.env.XFA_CONFIG_DIR; else process.env.XFA_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- HTTP status handling -------------------------------------------------

function httpErr(status, payload) {
  const e = new Error(`xlsx-for-ai API error ${status}: x`);
  e.status = status;
  e.payload = payload;
  return e;
}

test('support: 400 / 429 / 5xx / unreachable each give a distinct actionable message', async () => {
  const cases = [
    [httpErr(400, { error: { message: 'invalid email' } }), /rejected.*invalid email/],
    [httpErr(429, null), /too many requests/],
    [httpErr(503, null), /service had a problem \(HTTP 503\)/],
    [Object.assign(new Error('x'), { code: 'API_UNREACHABLE' }), /could not reach/],
  ];
  for (const [e, re] of cases) {
    const { deps, out, err } = harness({ post: async () => { throw e; } });
    const code = await runSupportSubcommand(['me@example.com', 'q'], deps);
    assert.equal(code, 1);
    assert.equal(out.length, 0);
    assert.match(err.join(''), re);
  }
});

// ---- flags ---------------------------------------------------------------

test('--help / -h print usage, exit 0, and never post', async () => {
  for (const [fn, flag] of [[runFeedbackSubcommand, '--help'], [runSupportSubcommand, '-h']]) {
    const { deps, calls, out } = harness();
    assert.equal(await fn([flag], deps), 0);
    assert.equal(calls.length, 0);
    assert.match(out.join(''), /Usage: xfa (feedback|support)/);
  }
});

test('--privacy=strict is honoured and not included in the message', async () => {
  const { deps, calls } = harness();
  const code = await runFeedbackSubcommand(['--privacy=strict', 'hello'], deps);
  assert.equal(code, 0);
  assert.equal(calls[0].opts.privacyStrict, true);
  assert.equal(calls[0].body.message, 'hello');
});

test('over-254-char email is rejected client-side', () => {
  const email = 'a'.repeat(250) + '@b.co';
  assert.equal(validateSupportArgs([email, 'q']).ok, false);
});

test('post() adds X-XFA-Privacy: strict for opts.privacyStrict and refuses reserved-header overrides', async () => {
  const client = require('../../lib/client');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const realErr = process.stderr.write;
  process.stderr.write = () => true; // silence timing log
  try {
    await client.post('/feedback', {}, {
      auth: false,
      privacyStrict: true,
      headers: { 'X-XFA-Internal': '1', 'content-type': 'text/evil', 'Authorization': 'x', 'bad name': 'v' },
    });
  } finally {
    global.fetch = realFetch;
    process.stderr.write = realErr;
  }
  const h = seen[0];
  assert.equal(h['X-XFA-Privacy'], 'strict');
  assert.equal(h['X-XFA-Internal'], '1');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['Authorization'], undefined);
  assert.equal(h['bad name'], undefined);
  assert.equal(h['content-type'], undefined);
});
