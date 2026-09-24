// publish-attestation-gate.test.js — the executable acceptance for XLS-1778 (gate cutover F).
//
// Drives the deterministic decision seam of scripts/publish-attestation-gate.sh
// (`--receipt-file … --expect-content-id …`) across the §13.1 predicate branches, and proves
// the §14.F acceptance verbatim:
//   "A publish attempt with a valid new-gate attestation for the exact published content
//    proceeds; one with a missing / mismatched / grace-style receipt is refused; no grace
//    reference remains in the publish path (the detach-guard passes on it)."
//
// The seam is network-free and crypto-free by design (the live cosign verify + artifact
// resolution are the go-live path, exercised only when card A's keys are wired). This is the
// same posture the previous gate's --receipt-file witness had: the decision LOGIC is the thing
// under test here.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..', '..');
const GATE = join(REPO, 'scripts', 'publish-attestation-gate.sh');
const GUARD = join(REPO, 'scripts', 'publish-path-detach-guard.sh');
const CID = 'a'.repeat(64);
const SIGNER = 'https://github.com/senoff/xlsx-for-ai/.github/workflows/review-gate.yml@refs/heads/main';
const CFG = 'cfg-hash-deadbeef';

const dir = mkdtempSync(join(tmpdir(), 'xls1778-'));
const allowlist = join(dir, 'allow.txt');
writeFileSync(allowlist, SIGNER + '\n');

// A fully-valid §13.1 attestation for content CID, signed by the allowlisted identity.
const VALID = {
  schema: 'review-attestation/1',
  subject_content_id: CID,
  authored_file_set: ['scripts/publish-attestation-gate.sh'],
  per_file_blob_hashes: { 'scripts/publish-attestation-gate.sh': 'deadbeef' },
  verdict: 'pass',
  risk_class: 'code',
  reviewer_slots: ['A:opus-4.8', 'B:chatgpt'],
  shadow_results: { gemini: 'pass' },
  rungs_passed: ['stage0', 'reviewerA', 'reviewerB'],
  signer_identity: SIGNER,
  config_hash: CFG,
  model_ids: ['claude-opus-4-8', 'gpt-x', 'gemini-x'],
  timestamp: '2026-09-24T00:00:00Z',
};

// Run the gate's deterministic seam; return { code, out }.
function runGate(receipt, { cid = CID, allow = allowlist, cfg = CFG, expectCid = true } = {}) {
  const f = join(dir, `r-${Math.random().toString(36).slice(2)}.json`);
  if (receipt !== null) writeFileSync(f, typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
  const args = ['--receipt-file', f];
  if (expectCid) args.push('--expect-content-id', cid);
  if (allow) args.push('--allowlist', allow);
  if (cfg) args.push('--config-hash', cfg);
  try {
    const out = execFileSync('bash', [GATE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ── §14.F: a valid attestation for the EXACT content PROCEEDS ────────────────────────
test('valid attestation for the exact published content → publish proceeds (exit 0)', () => {
  const r = runGate(VALID);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Publish may proceed/);
});

// ── §14.F: mismatched content → REFUSED ──────────────────────────────────────────────
test('subject_content_id for DIFFERENT content → refused (mismatch)', () => {
  const r = runGate(VALID, { cid: 'b'.repeat(64) });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /does not equal the published content's CONTENT_ID/);
});

test('one-byte authored change (attestation subject stale) → refused', () => {
  const stale = { ...VALID, subject_content_id: 'c'.repeat(64) };
  const r = runGate(stale);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /mismatch/i);
});

// ── §14.F: grace-style receipt → REFUSED (no carry-over of grace signatures) ──────────
test('grace-style receipt by schema → refused', () => {
  const r = runGate({ schema: 'grace-override-receipt/2', severity: 'NONE', pr: '77' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /GRACE-style receipt/);
});

test('grace-style receipt by structure (severity, no subject) → refused', () => {
  const r = runGate({ schema: 'something/1', severity: 'NONE' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /GRACE-style receipt/);
});

// ── §14.F: missing receipt → REFUSED ─────────────────────────────────────────────────
test('missing receipt file → refused (fail closed)', () => {
  const r = runGate(null);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /missing or empty/);
});

test('empty receipt → refused', () => {
  const r = runGate('');
  assert.strictEqual(r.code, 1, r.out);
});

test('invalid JSON → refused', () => {
  const r = runGate('{not json');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /not valid JSON/);
});

// ── §13.1 predicate branches, each fails closed ──────────────────────────────────────
test('verdict != pass → refused', () => {
  const r = runGate({ ...VALID, verdict: 'findings' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /verdict=/);
});

test('absent verdict → refused', () => {
  const { verdict, ...noVerdict } = VALID;
  const r = runGate(noVerdict);
  assert.strictEqual(r.code, 1, r.out);
});

test('wrong schema token → refused (fail closed on unimplemented contract)', () => {
  const r = runGate({ ...VALID, schema: 'review-attestation/999' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /is not 'review-attestation\/1'/);
});

test('missing a live reviewer slot (only A) → refused', () => {
  const r = runGate({ ...VALID, reviewer_slots: ['A:opus-4.8'] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /missing a live reviewer slot/);
});

test('a required rung not passed (no reviewerB) → refused', () => {
  const r = runGate({ ...VALID, rungs_passed: ['stage0', 'reviewerA'] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /rungs_passed is missing 'reviewerB'/);
});

test('signer not in allowlist → refused', () => {
  const r = runGate({ ...VALID, signer_identity: 'https://github.com/evil/repo/.github/workflows/x.yml@main' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /not in the allowlist/);
});

test('no signer_identity, with allowlist → refused', () => {
  const { signer_identity, ...noSigner } = VALID;
  const r = runGate(noSigner);
  assert.strictEqual(r.code, 1, r.out);
});

test('stale config_hash → refused', () => {
  const r = runGate({ ...VALID, config_hash: 'stale-cfg' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /config_hash=/);
});

test('--expect-content-id omitted → refused (seam requires a target content id)', () => {
  const r = runGate(VALID, { expectCid: false });
  assert.strictEqual(r.code, 1, r.out);
});

// ── §14.F: the detach-guard passes on the new publish path ───────────────────────────
test('detach-guard: publish path is grace-detached (exit 0)', () => {
  const out = execFileSync('bash', [GUARD], { encoding: 'utf8' });
  assert.match(out, /detach-guard PASS/);
});

test('detach-guard --selftest reddens on a planted grace attachment (exit 0)', () => {
  const out = execFileSync('bash', [GUARD, '--selftest'], { encoding: 'utf8' });
  assert.match(out, /selftest PASS/);
});

// ── Integration-contract alignment (SysArch F ruling, 2026-09-24) ─────────────────────
// F takes A's canonical signer-allowlist SHAPE: {oidc_issuer, allowed_signer_identities:[...]}.
const { chmodSync, mkdirSync } = require('node:fs');

test('A-shaped JSON signer-allowlist: allowlisted identity → proceeds', () => {
  const jsonAllow = join(dir, 'signer-allowlist.json');
  writeFileSync(jsonAllow, JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com',
    allowed_signer_identities: [SIGNER],
  }));
  const r = runGate(VALID, { allow: jsonAllow });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Publish may proceed/);
});

test('A-shaped JSON signer-allowlist: identity NOT in the list → refused', () => {
  const jsonAllow = join(dir, 'signer-allowlist-2.json');
  writeFileSync(jsonAllow, JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com',
    allowed_signer_identities: ['https://github.com/senoff/other/.github/workflows/review-gate.yml@refs/heads/main'],
  }));
  const r = runGate(VALID, { allow: jsonAllow });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /not in the allowlist/);
});

// A self-contained throwaway git repo with one or two commits — depth-independent (CI checks out
// shallow, so HEAD~1 of the real repo may not exist; these tests never rely on the checkout depth).
function makeRepo(twoCommits) {
  const rd = mkdtempSync(join(tmpdir(), 'xls1778-repo-'));
  const g = (...a) => execFileSync('git', ['-C', rd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a],
    { encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(rd, 'f.txt'), 'one\n');
  g('add', 'f.txt'); g('commit', '-q', '-m', 'c1');
  const base = g('rev-parse', 'HEAD').trim();
  let head = base;
  if (twoCommits) {
    writeFileSync(join(rd, 'f.txt'), 'one\ntwo\n');
    g('add', 'f.txt'); g('commit', '-q', '-m', 'c2');
    head = g('rev-parse', 'HEAD').trim();
  }
  return { dir: rd, base, head };
}

// ── SPM fail-open fix #2: an EMPTY diff must yield NO content_id (never sha256('')) ────
const CID_TOOL = join(REPO, 'scripts', 'content_id.py');
// Return { code, cid } — cid is whatever went to STDOUT (the value a caller would consume),
// captured regardless of exit code so we can assert an empty diff leaks NO content_id.
function contentId(repoDir, base, head) {
  try {
    const cid = execFileSync('python3', [CID_TOOL, repoDir, base, head],
      { encoding: 'utf8' }).trim();
    return { code: 0, cid };
  } catch (e) { return { code: e.status ?? 1, cid: (e.stdout || '').trim() }; }
}

test('content_id: empty diff (base==head) → NO content_id on stdout + fail-closed exit', () => {
  const repo = makeRepo(false);
  const r = contentId(repo.dir, repo.base, repo.base);
  assert.strictEqual(r.cid, '', `an empty diff must leak no content_id (not sha256 of ''); got: ${r.cid}`);
  assert.notStrictEqual(r.code, 0, 'an empty diff must exit non-zero (fail closed)');
});

test('content_id: a real change → a 64-hex content_id (exit 0)', () => {
  const repo = makeRepo(true);
  const r = contentId(repo.dir, repo.base, repo.head);
  assert.strictEqual(r.code, 0, r.cid);
  assert.match(r.cid, /^[0-9a-f]{64}$/, r.cid);
});

// ── SPM fail-open fix #1: live/enforce must REFUSE when the config-hash is undeterminable
// (unset GATE_CONFIG_HASH + no config manifest at base) — never silently skip the §8 staleness
// check. Driven with stub gh/cosign on PATH and a self-contained 2-commit repo (non-empty CID).
test('live/enforce: undeterminable gate config hash → refused (fail-open #1 closed)', () => {
  const repo = makeRepo(true);      // cwd for the gate; content_id.py "." runs here (non-empty diff)
  const HEAD = repo.head;
  const BASE = repo.base;

  // stub PATH: a gh that answers the commits→pulls lookup, and a no-op cosign so the enforce
  // precheck (cosign present) passes and we reach the config-hash guard.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'),
    `#!/usr/bin/env bash\n` +
    `if printf '%s ' "$@" | grep -q 'commits/.*/pulls'; then\n` +
    `  echo '[{"number":1,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${HEAD}"},"base":{"sha":"${BASE}"}}]'\n` +
    `  exit 0\nfi\nexit 0\n`);
  writeFileSync(join(bin, 'cosign'), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'cosign'), 0o755);

  // an A-shaped allowlist that RESOLVES (absolute fixture, survives base-ref lookup) so the run
  // gets past the allowlist gate and the ONLY thing missing is the config hash.
  const jsonAllow = join(dir, 'allow-live.json');
  writeFileSync(jsonAllow, JSON.stringify({ allowed_signer_identities: [SIGNER] }));

  let r;
  try {
    execFileSync('bash', [GATE], {
      cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ATTESTATION_VERIFY_MODE: 'enforce',
        GITHUB_REPOSITORY: 'senoff/xlsx-for-ai',
        GITHUB_SHA: HEAD,
        COSIGN_IDENTITY: SIGNER,
        ATTESTATION_ALLOWLIST: jsonAllow,
        GATE_CONFIG_MANIFEST: '.github/review-gate/config-manifest.txt', // absent at base
        GATE_CONFIG_HASH: '', // explicitly unset
      },
    });
    r = { code: 0, out: '' };
  } catch (e) {
    r = { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /gate config hash could not be determined/, r.out);
});
