'use strict';

// XLS-657 — unit coverage for the shared 4xx surfacer/sanitizer
// (lib/inline-4xx.js) that both the MCP path (mcp.js) and the CLI path
// (index.js) call. The end-to-end behavior is covered by friendly-error
// (MCP) and cli-4xx-passthrough (CLI); this pins the shared unit, in
// particular the grace-found path-with-spaces leak.

const { test } = require('node:test');
const assert = require('node:assert');
const { surface4xx, shapeInline4xxMessage } = require('../../lib/inline-4xx');

function clientErr({ status, payload, message }) {
  const e = new Error(message ?? `xlsx-for-ai API error ${status}: x`);
  e.code = 'API_CLIENT_ERROR';
  e.status = status;
  e.payload = payload;
  return e;
}

// --- the grace-found leak: paths WITH SPACES ------------------------------

test('POSIX path with spaces + extension is fully redacted (no tail leak)', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'could not read /Users/Bob Smith/Desktop/My Secrets/file.xlsx now' } },
  }));
  assert.ok(!out.includes('Bob Smith'), `username must not leak; got: ${out}`);
  assert.ok(!out.includes('My Secrets'), `path tail must not leak; got: ${out}`);
  assert.ok(!out.includes('file.xlsx'), `filename must not leak; got: ${out}`);
  assert.ok(out.includes('<path>'), `expected <path> placeholder; got: ${out}`);
  // Surrounding prose survives.
  assert.ok(out.includes('could not read') && out.includes('now'),
    `actionable prose must survive; got: ${out}`);
});

test('Windows path with spaces + extension is fully redacted', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'bad path C:\\Users\\Bob Smith\\secret.xlsx here' } },
  }));
  assert.ok(!out.includes('Bob Smith'), `got: ${out}`);
  assert.ok(!out.includes('secret.xlsx'), `got: ${out}`);
  assert.ok(out.includes('<path>'), `got: ${out}`);
  assert.ok(out.includes('bad path') && out.includes('here'), `prose survives; got: ${out}`);
});

test('Windows extensionless path with spaces redacts the username segment', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'dir C:\\Users\\Bob Smith\\Documents missing' } },
  }));
  assert.ok(!out.includes('Bob Smith'), `Windows username must be redacted; got: ${out}`);
  assert.ok(out.includes('<path>'), `got: ${out}`);
});

test('parenthesized paths are fully scrubbed (POSIX and Windows)', () => {
  const posix = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'read /Users/bob/My File (1).xlsx failed' } },
  }));
  assert.ok(!posix.includes('My File (1).xlsx') && posix.includes('<path>'), `posix parens; got: ${posix}`);
  const win = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'load C:\\Program Files (x86)\\app\\config.ini here' } },
  }));
  assert.ok(!win.includes('Program Files (x86)') && win.includes('<path>'), `windows parens; got: ${win}`);
  assert.ok(win.includes('load') && win.includes('here'), `prose survives; got: ${win}`);
});

test('UNC Windows paths are scrubbed (with and without extension)', () => {
  const withExt = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'open \\\\fileserver\\share\\secret.xlsx now' } },
  }));
  assert.ok(!withExt.includes('secret.xlsx') && !withExt.includes('fileserver') && withExt.includes('<path>'),
    `UNC w/ ext; got: ${withExt}`);
  const noExt = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'missing \\\\fileserver\\share\\folder end' } },
  }));
  assert.ok(!noExt.includes('fileserver') && noExt.includes('<path>'), `UNC no ext; got: ${noExt}`);
});

test('extensionless POSIX home path still redacts the username segment', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'dir /Users/Bob Smith/Documents missing' } },
  }));
  assert.ok(!out.includes('Bob Smith'), `username must be redacted even w/o extension; got: ${out}`);
  assert.ok(out.includes('<path>'), `got: ${out}`);
});

test('path redaction does NOT eat trailing prose (shape preserved)', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'validation failed reading /Users/bob/Desktop/secret.xlsx at row 3' } },
  }));
  assert.ok(!out.includes('/Users/bob/Desktop/secret.xlsx'), `got: ${out}`);
  assert.ok(out.includes('validation failed reading') && out.includes('at row 3'),
    `prose on both sides of the path must survive; got: ${out}`);
});

test('extension-anchored redaction is root-agnostic (non-allowlist POSIX root)', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'could not open /data/tenant42/export.csv now' } },
  }));
  assert.ok(!out.includes('tenant42') && !out.includes('export.csv'), `non-listed root must redact; got: ${out}`);
  assert.ok(out.includes('<path>'), `got: ${out}`);
  assert.ok(out.includes('could not open') && out.includes('now'), `prose survives; got: ${out}`);
});

test('extension-anchored redaction terminates on trailing punctuation (no leak)', () => {
  for (const [msg, leak] of [
    ['could not open /data/tenant42/export.csv, retrying', 'tenant42'],
    ['bad file /data/x/report.xlsx.', 'report.xlsx'],
    ['see /home/alice/notes.txt; then stop', 'alice'],
    ['load C:\\data\\book.xlsx, then', 'book.xlsx'],
  ]) {
    const out = surface4xx('t', clientErr({ status: 400, payload: { error: { message: msg } } }));
    assert.ok(!out.includes(leak), `punctuation boundary must not leak (${msg}); got: ${out}`);
    assert.ok(out.includes('<path>'), `expected <path> (${msg}); got: ${out}`);
  }
});

test('a quote INSIDE a filename does not leak the path tail (inner excludes only newline)', () => {
  for (const [msg, leak] of [
    ["could not read /Users/obrien/O'Brien budget.xlsx now", 'obrien'],
    ["bad file /data/it's a report.csv here", "it's a report"],
    ['open C:\\Users\\d\'angelo\\book.xlsx please', 'angelo'],
  ]) {
    const out = surface4xx('t', clientErr({ status: 400, payload: { error: { message: msg } } }));
    assert.ok(!out.includes(leak), `quote-in-filename must not leak (${msg}); got: ${out}`);
    assert.ok(out.includes('<path>'), `expected <path> (${msg}); got: ${out}`);
  }
});

test('path redaction fires regardless of the char immediately BEFORE the path', () => {
  // The left boundary rejects only URL markers (`:` `/` host-char), so a path
  // preceded by a backtick, `=`, `(`, or `<` is still redacted.
  for (const [msg, leak] of [
    ['see `/data/priv/report.xlsx` for detail', 'priv'],
    ['path=/data/customer/x.csv failed', 'customer'],
    ['(/srv/www/app/secret.env)', 'secret.env'],
    ['<config>/etc/app/db.conf</config>', '/etc/app/db.conf'],
  ]) {
    const out = surface4xx('t', clientErr({ status: 400, payload: { error: { message: msg } } }));
    assert.ok(!out.includes(leak), `left-boundary must not block redaction (${msg}); got: ${out}`);
    assert.ok(out.includes('<path>'), `expected <path> (${msg}); got: ${out}`);
  }
});

test('terminator covers braces/angle-brackets and non-ASCII extensions', () => {
  const brace = surface4xx('t', clientErr({ status: 400, payload: { error: { message: 'json {"file":"/data/x/report.xlsx"}' } } }));
  assert.ok(!brace.includes('report.xlsx') && brace.includes('<path>'), `brace boundary; got: ${brace}`);
  const nonAscii = surface4xx('t', clientErr({ status: 400, payload: { error: { message: 'open /data/файл.данные now' } } }));
  assert.ok(!nonAscii.includes('файл') && nonAscii.includes('<path>'), `non-ASCII extension; got: ${nonAscii}`);
});

test('multi-dot extensions (.tar.gz) are redacted as one path token', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'archive /var/backups/db.tar.gz is corrupt' } },
  }));
  assert.ok(!out.includes('db.tar.gz') && !out.includes('backups'), `got: ${out}`);
  assert.ok(out.includes('<path>') && out.includes('is corrupt'), `prose survives; got: ${out}`);
});

test('a URL is NOT eaten by the POSIX path pass (leading-boundary anchor, no lookbehind)', () => {
  const out = surface4xx('t', clientErr({
    status: 400,
    payload: { error: { message: 'see https://api.example.com/data/report.json for the schema' } },
  }));
  // The host/scheme survives — every `/` in the URL is preceded by a non-boundary char.
  assert.ok(out.includes('https://api.example.com'), `URL host must survive; got: ${out}`);
});

// --- MEDIUM: string status still hits the curated branches -----------------

test('string status "429" is handled as a limit; with no server message the fallback is not a monthly cap', () => {
  const out = surface4xx('t', clientErr({ status: '429', payload: null, message: 'xlsx-for-ai API error 429: Too Many Requests' }));
  assert.ok(out.includes('usage limit was reached'), `got: ${out}`);
  assert.ok(!out.includes('monthly') && !out.includes('next month'), `got: ${out}`);
});
test('numeric status 429 shows the server message and its retry time', () => {
  const out = surface4xx('t', clientErr({ status: 429, payload: { error: { message: 'Slow down.', retry_after_seconds: 30 } } }));
  assert.ok(out.includes('Slow down.') && out.includes('30 seconds'), `got: ${out}`);
});
test('B1-16: string status "402" shows the server\'s sentence and its upgrade link', () => {
  const out = surface4xx('t', clientErr({
    status: '402',
    payload: { error: { message: 'You have used your 500 free files this month.', upgrade: { url: 'https://xlsx-for-ai.dev/upgrade?r=1', plan: 'pro', reason: 'plan1_monthly_over' } } },
  }));
  assert.ok(out.includes('You have used your 500 free files this month.'), `got: ${out}`);
  assert.ok(out.includes('https://xlsx-for-ai.dev/upgrade?r=1'), `the pay link must be shown; got: ${out}`);
  assert.ok(!out.includes('capture mode'), `got: ${out}`);
});
test('402 with no message from the server falls back to a plain line and the site', () => {
  const out = surface4xx('t', clientErr({ status: 402, payload: null, message: 'xlsx-for-ai API error 402: Payment Required' }));
  assert.ok(out.includes('paid plan') && out.includes('https://xlsx-for-ai.dev'), `got: ${out}`);
});

// --- fallbacks + bounds ----------------------------------------------------

test('empty/absent payload → graceful fallback, no undefined/[object Object]', () => {
  const out = surface4xx('t', clientErr({ status: 400, payload: null, message: 'xlsx-for-ai API error 400: ' }));
  assert.ok(!out.includes('undefined') && !out.includes('[object Object]'), `got: ${out}`);
  assert.ok(out.includes('invalid request (no detail provided)'), `got: ${out}`);
});

test('shapeInline4xxMessage bounds length with an ellipsis', () => {
  const out = shapeInline4xxMessage('y'.repeat(500));
  assert.ok(out.length <= 280, `expected <=280; got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('each scrubber class fires (email, jwt, bearer, slack, xfa key, hex)', () => {
  const cases = [
    ['user a@b.co here', 'a@b.co', '<email>'],
    ['tok eyJabcdefgh.ijklmnop.qrstuvwx here', 'eyJabcdefgh', '<jwt>'],
    ['auth Bearer abcdef12345678 x', 'abcdef12345678', '<bearer>'],
    ['t xoxb-1234567890-abcdef x', 'xoxb-1234567890', '<slack-token>'],
    ['k xfa_live_ABCDEFGHIJKLMNOP1234 x', 'xfa_live_ABCDEFGHIJKLMNOP1234', '<xfa-key>'],
    ['h ' + 'a'.repeat(40) + ' x', 'a'.repeat(40), '<hex>'],
  ];
  for (const [msg, secret, placeholder] of cases) {
    const out = shapeInline4xxMessage(msg);
    assert.ok(!out.includes(secret), `secret leaked for ${placeholder}: ${out}`);
    assert.ok(out.includes(placeholder), `missing ${placeholder}: ${out}`);
  }
});
