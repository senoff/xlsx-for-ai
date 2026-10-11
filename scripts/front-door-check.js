'use strict';

/**
 * XLS-2993: the checks only this package owns on the way into the product.
 *
 * The shared paths (the website, the API, the connector) are specified and
 * checked in the server repo (docs/front-door-spec.md there). This script
 * covers what only the package can show, against the package as a person gets
 * it: packed, then installed into an empty folder.
 *
 *   PK-1  it installs
 *   PK-2  both commands start (xlsx-for-ai --version, xlsx-for-ai-mcp answers initialize and lists tools with no key)
 *   PK-3  the version matches what npm serves as latest
 *   PK-4  the first-run sign-in text is the sentence a new person is meant to read
 *
 * Modes for PK-3:
 *   --mode=pre   (default) before a release: this version is the latest or newer than it
 *   --mode=post  after a release: this version IS the latest npm serves
 *
 * Nothing here signs anyone in or calls the product API; the only network use is
 * `npm install` of the local tarball's dependencies and one read of the npm registry.
 * Prints one line per check and a PASS/FAIL summary. Exit 0 if no FAIL, 1 otherwise.
 * `--skip-registry` marks PK-3 NOT-CHECKABLE (offline runs); it is never a pass.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NEW_PERSON_SENTENCE = 'xlsx-for-ai is free, and it needs a one-time sign-in before it can work on your spreadsheet.';

function parseArgs(argv) {
  const o = { mode: 'pre', skipRegistry: false, registryUrl: 'https://registry.npmjs.org/xlsx-for-ai/latest' };
  for (const a of argv) {
    if (a === '--mode=pre') o.mode = 'pre';
    else if (a === '--mode=post') o.mode = 'post';
    else if (a === '--skip-registry') o.skipRegistry = true;
    else if (a.startsWith('--registry-url=')) o.registryUrl = a.slice('--registry-url='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** Compare x.y.z strings. Returns -1, 0, 1. Throws on anything that is not three numbers. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
    if (!m) throw new Error(`not a x.y.z version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Judge PK-3 from the two versions and the mode. Pure. */
function judgeVersion(local, latest, mode) {
  let cmp;
  try { cmp = compareVersions(local, latest); } catch (e) { return { status: 'FAIL', note: e.message }; }
  if (mode === 'post') {
    return cmp === 0
      ? { status: 'PASS', note: `package ${local} is what npm serves as latest` }
      : { status: 'FAIL', note: `package is ${local} but npm serves ${latest} as latest` };
  }
  return cmp >= 0
    ? { status: 'PASS', note: `package ${local}, npm latest ${latest} (this version is the latest or newer)` }
    : { status: 'FAIL', note: `package ${local} is older than npm latest ${latest}` };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 240000, ...opts });
}

/** Start the installed MCP server, ask initialize then tools/list. Resolves { initialize, tools } or rejects. */
function askMcp(binPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const answers = new Map();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the MCP command did not answer in 60 seconds')); }, 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const o = JSON.parse(line); if (o.id !== undefined) answers.set(o.id, o); } catch (_) { /* not JSON-RPC */ }
      }
      if (answers.has(1) && !answers.has(2)) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      }
      if (answers.has(1) && answers.has(2)) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ initialize: answers.get(1), tools: answers.get(2) });
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'front-door-check', version: '0' } },
    }) + '\n');
  });
}

async function fetchLatest(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.version !== 'string') throw new Error('registry answer has no version');
  return body.version;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const results = [];
  const add = (id, status, note) => { results.push({ id, status, note }); console.log(`${id} ${status}: ${note}`); };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-front-door-'));
  const project = path.join(work, 'project');
  const config = path.join(work, 'config');
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  let installed = null;
  try {
    // PK-1: pack the package as it would be published, install the tarball into an empty folder.
    const pack = run('npm', ['pack', '--silent', '--pack-destination', work], { cwd: ROOT });
    const tarball = pack.status === 0 ? path.join(work, pack.stdout.trim().split('\n').pop()) : null;
    if (!tarball || !fs.existsSync(tarball)) {
      add('PK-1', 'FAIL', `npm pack failed: ${(pack.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
    } else {
      fs.writeFileSync(path.join(project, 'package.json'), '{"name":"front-door-probe","version":"0.0.0","private":true}');
      const inst = run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: project });
      installed = path.join(project, 'node_modules', 'xlsx-for-ai');
      if (inst.status !== 0 || !fs.existsSync(path.join(installed, 'package.json'))) {
        add('PK-1', 'FAIL', `npm install of the packed tarball failed: ${(inst.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
        installed = null;
      } else {
        add('PK-1', 'PASS', `packed and installed ${PKG.name}@${PKG.version} into an empty folder`);
      }
    }

    const env = { ...process.env, XFA_CONFIG_DIR: config, XFA_NO_AUTO_UPDATE: '1', XLSX_FOR_AI_API: 'http://127.0.0.1:1' };
    for (const k of ['CI', 'GITHUB_ACTIONS', 'XLSX_FOR_AI_CI', 'XFA_NONINTERACTIVE']) delete env[k];

    // PK-2: both commands start.
    if (!installed) {
      add('PK-2', 'FAIL', 'nothing installed, so neither command could be started');
    } else {
      const bin = (name) => path.join(project, 'node_modules', '.bin', name);
      const notes = [];
      let ok = true;
      const v = run(bin('xlsx-for-ai'), ['--version'], { env, cwd: project });
      if (v.status === 0 && v.stdout.trim() === PKG.version) notes.push(`xlsx-for-ai --version printed ${PKG.version}`);
      else { ok = false; notes.push(`xlsx-for-ai --version exited ${v.status} and printed "${(v.stdout || '').trim().slice(0, 40)}"`); }
      try {
        const m = await askMcp(path.join(installed, 'mcp.js'), env);
        const list = m.tools && m.tools.result && m.tools.result.tools;
        const serverName = m.initialize && m.initialize.result && m.initialize.result.serverInfo && m.initialize.result.serverInfo.name;
        if (serverName && Array.isArray(list) && list.length > 0) notes.push(`xlsx-for-ai-mcp answered initialize as ${serverName} and listed ${list.length} tools with no key`);
        else { ok = false; notes.push('xlsx-for-ai-mcp did not answer initialize and tools/list with a server name and tools'); }
      } catch (e) {
        ok = false; notes.push(`xlsx-for-ai-mcp: ${e.message}`);
      }
      add('PK-2', ok ? 'PASS' : 'FAIL', notes.join('; '));
    }

    // PK-3: version against npm latest.
    if (opts.skipRegistry) {
      add('PK-3', 'NOT-CHECKABLE', 'registry read skipped by --skip-registry');
    } else {
      try {
        const latest = await fetchLatest(opts.registryUrl);
        const j = judgeVersion(PKG.version, latest, opts.mode);
        add('PK-3', j.status, `${j.note} [mode ${opts.mode}]`);
      } catch (e) {
        add('PK-3', 'FAIL', `could not read the npm registry: ${e.message}`);
      }
    }

    // PK-4: the first-run sign-in text, from the installed package.
    if (!installed) {
      add('PK-4', 'FAIL', 'nothing installed');
    } else {
      try {
        const { signInMessage } = require(path.join(installed, 'lib', 'mcp-signin.js'));
        const text = signInMessage({ link: 'https://example.invalid/oauth/device?user_code=AAAA-BBBB', code: 'AAAA-BBBB', expiresAt: Date.now() + 600000 });
        const checks = [
          [text.includes(NEW_PERSON_SENTENCE), 'the first-run sentence'],
          [text.includes('https://example.invalid/oauth/device?user_code=AAAA-BBBB'), 'the link'],
          [text.includes('AAAA-BBBB'), 'the code'],
          [!/terminal|xlsx-for-ai login/i.test(text), 'no mention of a terminal or a command'],
        ];
        const missing = checks.filter((c) => !c[0]).map((c) => c[1]);
        if (missing.length === 0) add('PK-4', 'PASS', 'the installed package shows the first-run sentence, link and code, and names no terminal');
        else add('PK-4', 'FAIL', `the first-run text is missing or wrong: ${missing.join(', ')}`);
      } catch (e) {
        add('PK-4', 'FAIL', `could not load the installed sign-in text: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('NOT-CHECKABLE')} NOT-CHECKABLE`);
  return count('FAIL') === 0 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`front-door-check: ${e.message}`); process.exit(2); });
}

module.exports = { parseArgs, compareVersions, judgeVersion, NEW_PERSON_SENTENCE };
