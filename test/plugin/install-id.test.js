'use strict';
// XLS-11647: the plugin's headersHelper. It makes a random install id once in the plugin's own
// data folder, readable by the user only, and prints {"x-xfa-install":"<id>"} and nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'claude-code-plugin', 'scripts', 'install-id.sh');
const ID = /^\{"x-xfa-install":"([0-9a-f]{64})"\}\n$/;

const run = (args, env = {}) => {
  const base = { PATH: process.env.PATH };
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { ...base, ...env }, timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-install-id-'));

test('creates a 64-hex id once, mode 600, and prints only the header JSON', () => {
  const data = path.join(tmp(), 'data');
  const out = run([data]);
  const m = ID.exec(out);
  assert.ok(m, out);
  assert.deepEqual(JSON.parse(out), { 'x-xfa-install': m[1] });
  assert.equal(fs.readFileSync(path.join(data, 'install-id'), 'utf8'), m[1]);
  assert.deepEqual(fs.readdirSync(data), ['install-id'], 'no temp file left behind');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(data, 'install-id')).mode & 0o777, 0o600);
});

test('prints the same id on every later run', () => {
  const data = tmp();
  const first = run([data]);
  assert.equal(run([data]), first);
  assert.equal(run([], { CLAUDE_PLUGIN_DATA: data }), first, 'CLAUDE_PLUGIN_DATA is used when no argument is given');
});

test('two installs get different ids', () => {
  assert.notEqual(run([tmp()]), run([tmp()]));
});

test('a damaged id file is replaced with a fresh id', () => {
  const data = tmp();
  fs.writeFileSync(path.join(data, 'install-id'), 'not-an-id"}');
  const m = ID.exec(run([data]));
  assert.ok(m);
  assert.equal(fs.readFileSync(path.join(data, 'install-id'), 'utf8'), m[1]);
});

test('a loosened file mode is set back to 600', { skip: process.platform === 'win32' }, () => {
  const data = tmp();
  run([data]);
  fs.chmodSync(path.join(data, 'install-id'), 0o644);
  run([data]);
  assert.equal(fs.statSync(path.join(data, 'install-id')).mode & 0o777, 0o600);
});

test('with no data folder it prints {} so the server answers as before', () => {
  assert.equal(run([]), '{}\n');
  assert.equal(run(['']), '{}\n');
});

test('a data folder it cannot create prints {}', () => {
  const file = path.join(tmp(), 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal(run([path.join(file, 'sub')]), '{}\n');
});

test('the script reads only its own id file and /dev/urandom', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /curl|wget|nc |\$HOME|~\/|\.claude|\.config|eval /);
  assert.match(code, /\/dev\/urandom/);
});
