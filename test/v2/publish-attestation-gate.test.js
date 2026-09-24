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
