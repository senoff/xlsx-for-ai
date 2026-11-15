'use strict';

// The CLI read path must omit options.sheet unless --sheet is given, so the server reads the
// first sheet (an empty sheet name answered 400 Sheet "" not found). Real-CLI spawn against a
// capturing mock server; XLSX_FOR_AI_CI=1 skips registration so the tool POST is the only call.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const INDEX = path.join(__dirname, '..', '..', 'index.js');
let FILE, server, port, lastBody;

before(async () => {
  FILE = path.join(os.tmpdir(), `xfa-nosheet-${process.pid}.csv`);
  fs.writeFileSync(FILE, 'a,b\n1,2\n');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      try { lastBody = JSON.parse(raw); } catch (_) { lastBody = null; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ text: 'FIRST-SHEET-OUTPUT' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.close(); try { fs.unlinkSync(FILE); } catch (_) {} });

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [INDEX, ...args], {
      env: { ...process.env, XLSX_FOR_AI_CI: '1', XLSX_FOR_AI_API: `http://127.0.0.1:${port}` },
    });
    let stdout = '';
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 30_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout }); });
  });
}

for (const args of [[], ['--json']]) {
  test(`xfa file.csv ${args.join(' ')} sends no sheet and prints the result`, async () => {
    lastBody = null;
    const r = await runCli([FILE, ...args]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /FIRST-SHEET-OUTPUT/);
    assert.ok(lastBody && lastBody.options, 'request body captured');
    assert.ok(!('sheet' in lastBody.options), 'options.sheet must be omitted: ' + JSON.stringify(lastBody.options));
  });
}

test('--sheet still sends the named sheet', async () => {
  lastBody = null;
  await runCli([FILE, '--sheet', 'Data']);
  assert.equal(lastBody.options.sheet, 'Data');
});
