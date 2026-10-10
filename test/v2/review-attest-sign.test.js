// review-attest-sign.test.js: XLS-1540 acceptance for the publish gate's signer setup.
//
// The npm publish gate (scripts/publish-attestation-gate.sh) refused every release since 4.0.7
// because this repo had no signer allowlist, no gate config manifest and no signing workflow. This
// proves the pieces now fit together end to end, crypto aside:
//   1. the committed allowlist / manifest / workflow all name the SAME exact identity the gate pins;
//   2. the manifest is fully measurable on this repo (every listed file exists);
//   3. a predicate built by scripts/review_attest_sign.py for a real base...head is ACCEPTED by the
//      gate's own decide() seam with the CONTENT_ID and config_hash the gate recomputes, and is
//      REFUSED once the authored content or the gate config changes after signing.
// The keyless cosign signature itself is exercised live by the workflow (it verify-blobs before
// posting) and by the publish run.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');

const REPO = resolve(__dirname, '..', '..');
const GATE = join(REPO, 'scripts', 'publish-attestation-gate.sh');
const SIGN = join(REPO, 'scripts', 'review_attest_sign.py');
const CID = join(REPO, 'scripts', 'content_id.py');
const CFGHASH = join(REPO, 'scripts', 'gate_config_hash.py');
const ALLOW = join(REPO, '.github', 'review-gate', 'signer-allowlist.json');
const MANIFEST_REL = '.github/review-gate/config-manifest.txt';
const IDENTITY = 'https://github.com/senoff/xlsx-for-ai/.github/workflows/review-gate.yml@refs/heads/main';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const git = (cwd, ...args) => run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args]).trim();

function gate(blob, cid, cfg) {
  try {
    return { code: 0, out: run('bash', [GATE, '--receipt-file', blob, '--expect-content-id', cid, '--allowlist', ALLOW, '--config-hash', cfg]) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

// A throwaway repo carrying a copy of this repo's gate config, with a base and a head commit.
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'xls1540-sign-'));
  git(dir, 'init', '-q', '-b', 'main');
  const manifest = readFileSync(join(REPO, MANIFEST_REL), 'utf8');
  const listed = manifest.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const rel of listed) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(dir, rel));
  }
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.1"}\n');
  git(dir, 'commit', '-q', '-am', 'release');
  const head = git(dir, 'rev-parse', 'HEAD');
  return { dir, base, head };
}

function sign(dir, base, head) {
  const blob = join(dir, '..', `${Math.random().toString(36).slice(2)}.blob`);
  run('python3', [SIGN, '--repo-dir', dir, '--repo-root', dir, '--base', base, '--head', head,
    '--config-manifest', MANIFEST_REL, '--signer-identity', IDENTITY, '--out-blob', blob]);
  return blob;
}

test('allowlist, gate default and workflow all pin the same exact signer identity', () => {
  const allow = JSON.parse(readFileSync(ALLOW, 'utf8'));
  assert.strictEqual(allow.oidc_issuer, 'https://token.actions.githubusercontent.com');
  assert.deepStrictEqual(allow.allowed_signer_identities, [IDENTITY]);
  assert.ok(readFileSync(GATE, 'utf8').includes(`COSIGN_IDENTITY:-${IDENTITY}`), 'gate COSIGN_IDENTITY default differs');
  const wf = readFileSync(join(REPO, '.github', 'workflows', 'review-gate.yml'), 'utf8');
  assert.match(wf, /^name: review-gate$/m);
  assert.ok(wf.includes('/.github/workflows/review-gate.yml@${GITHUB_REF}'), 'workflow signs under a different identity');
  assert.ok(wf.includes('"refs/heads/main"'), 'workflow must refuse to sign from any ref but main');
});

test('every file the manifest lists exists, so config_hash is computable on this repo', () => {
  const listed = readFileSync(join(REPO, MANIFEST_REL), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(listed.includes(MANIFEST_REL) && listed.includes('.github/review-gate/signer-allowlist.json'));
  for (const rel of listed) assert.ok(existsSync(join(REPO, rel)), `manifest lists missing file ${rel}`);
  assert.match(run('python3', [CFGHASH, REPO, join(REPO, MANIFEST_REL)]), /^[0-9a-f]{64}$/);
});

test('a predicate signed for base...head passes the publish gate with the values it recomputes', () => {
  const { dir, base, head } = fixtureRepo();
  const blob = sign(dir, base, head);
  const p = JSON.parse(readFileSync(blob, 'utf8'));
  assert.ok(!readFileSync(blob, 'utf8').includes('\n'), 'blob is not compact canonical JSON');
  assert.deepStrictEqual(p.authored_file_set, ['package.json']);
  assert.strictEqual(p.signer_identity, IDENTITY);
  const cid = run('python3', [CID, dir, base, head]).trim();
  const cfg = run('python3', [CFGHASH, dir, join(dir, MANIFEST_REL)]).trim();
  const r = gate(blob, cid, cfg);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /attestation OK/);
});

test('content changed after signing → the gate refuses (CONTENT_ID mismatch)', () => {
  const { dir, base, head } = fixtureRepo();
  const blob = sign(dir, base, head);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.2"}\n');
  git(dir, 'commit', '-q', '-am', 'later');
  const cid = run('python3', [CID, dir, base, 'HEAD']).trim();
  const cfg = run('python3', [CFGHASH, dir, join(dir, MANIFEST_REL)]).trim();
  const r = gate(blob, cid, cfg);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /mismatch/);
});

test('gate config changed after signing → the gate refuses (stale config_hash)', () => {
  const { dir, base, head } = fixtureRepo();
  const blob = sign(dir, base, head);
  const cid = run('python3', [CID, dir, base, head]).trim();
  writeFileSync(join(dir, '.github', 'review-gate', 'signer-allowlist.json'), '{"allowed_signer_identities":[]}\n');
  const cfg = run('python3', [CFGHASH, dir, join(dir, MANIFEST_REL)]).trim();
  const r = gate(blob, cid, cfg);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /stale gate config/);
});

test('empty diff → the signer refuses and writes nothing', () => {
  const { dir, base } = fixtureRepo();
  assert.throws(() => sign(dir, base, base), /REFUSED/);
});
