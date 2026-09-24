// publish-attestation-gate.test.js — the executable acceptance for XLS-1778 (gate cutover F).
//
// Drives the deterministic decision seam of scripts/publish-attestation-gate.sh
// (`--receipt-file … --expect-content-id …`) across the §13.1 predicate branches, and proves
// the §14.F acceptance verbatim:
//   "A publish attempt with a valid new-gate attestation for the exact published content
//    proceeds; one with a missing / mismatched / grace-style receipt is refused; no grace
//    reference remains in the publish path (the detach-guard passes on it)."
//
// The seam is network-free and crypto-free by design; the live path (card A's signed comment
// MARKER resolution + cosign keyless verify) is exercised separately with stub gh/cosign. This is
// the same posture the previous gate's --receipt-file witness had: the decision LOGIC is the thing
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

// A fully-valid §13.1 marker predicate for content CID, signed by the allowlisted identity.
const VALID = {
  predicate_type: 'review-attestation/1',
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

test('wrong predicate_type → refused (fail closed on unimplemented contract)', () => {
  const r = runGate({ ...VALID, predicate_type: 'review-attestation/999' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /is not 'review-attestation\/1'/);
});

test('absent predicate_type → refused', () => {
  const { predicate_type, ...noType } = VALID;
  const r = runGate(noType);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /predicate_type/);
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

// ── DELIVERY = signed comment-MARKER (SysArch Confirm #2): live path resolves card A's marker ──
// Build a stub `gh` (answers commits→pulls AND issues→comments) and a stub `cosign` (verify rc),
// a self-contained 2-commit repo for a real CONTENT_ID, and an A-shaped marker attesting it.
function runLiveMarker({ cosignRc = 0, withMarker = true, markerCid = null, configHash = 'cfg-live' } = {}) {
  const repo = makeRepo(true);
  const realCid = contentId(repo.dir, repo.base, repo.head).cid;
  const bin = mkdtempSync(join(tmpdir(), 'xls1778-bin-'));
  const jsonAllow = join(bin, 'allow.json');
  writeFileSync(jsonAllow, JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com',
    allowed_signer_identities: [SIGNER],
  }));

  const predicate = {
    predicate_type: 'review-attestation/1',
    subject_content_id: markerCid || realCid,
    verdict: 'pass',
    reviewer_slots: ['A:claude-opus-4-8', 'B:chatgpt'],
    rungs_passed: ['stage0', 'reviewerA', 'reviewerB'],
    signer_identity: SIGNER,
    config_hash: configHash,
  };
  const marker = 'review-attest-marker: ' + JSON.stringify({
    blob_b64: Buffer.from(JSON.stringify(predicate)).toString('base64'),
    bundle_b64: Buffer.from('stub-bundle').toString('base64'),
  });

  // stub gh: commits/*/pulls -> the merged PR (base/head from the temp repo); issues/*/comments
  // -q .[].body -> the marker line (or nothing when withMarker=false).
  writeFileSync(join(bin, 'gh'),
    `#!/usr/bin/env bash\n` +
    `args="$*"\n` +
    `if printf '%s' "$args" | grep -q 'commits/.*/pulls'; then\n` +
    `  echo '[{"number":7,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${repo.head}"},"base":{"sha":"${repo.base}"}}]'\n` +
    `  exit 0\nfi\n` +
    `if printf '%s' "$args" | grep -q 'issues/.*/comments'; then\n` +
    (withMarker ? `  cat <<'MARK'\n${marker}\nMARK\n` : ``) +
    `  exit 0\nfi\nexit 0\n`);
  writeFileSync(join(bin, 'cosign'), `#!/usr/bin/env bash\nexit ${cosignRc}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'cosign'), 0o755);

  try {
    const out = execFileSync('bash', [GATE], {
      cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ATTESTATION_VERIFY_MODE: 'enforce',
        GITHUB_REPOSITORY: 'senoff/xlsx-for-ai',
        GITHUB_SHA: repo.head,
        COSIGN_IDENTITY: SIGNER,
        COSIGN_BIN: 'cosign',
        ATTESTATION_ALLOWLIST: jsonAllow,
        GATE_CONFIG_HASH: configHash, // seam override so the base-ref config resolution is skipped
      },
    });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('live marker: a valid signed marker for the published CONTENT_ID → publish proceeds', () => {
  const r = runLiveMarker({});
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Publish may proceed/);
});

test('live marker: no review-attest-marker on the PR → refused (fail closed)', () => {
  const r = runLiveMarker({ withMarker: false });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no authentic review-attest-marker|Refusing to publish/);
});

test('live marker: cosign signature does NOT verify → refused (fail closed)', () => {
  const r = runLiveMarker({ cosignRc: 1 });
  assert.strictEqual(r.code, 1, r.out);
});

test('live marker: marker attests a DIFFERENT content_id → refused (no subject match)', () => {
  const r = runLiveMarker({ markerCid: 'd'.repeat(64) });
  assert.strictEqual(r.code, 1, r.out);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// SPM re-review (2026-09-24) regressions — the marker-resolution path hardening.
// ══════════════════════════════════════════════════════════════════════════════════════
const { dirname } = require('node:path');
const CFGHASH = join(REPO, 'scripts', 'gate_config_hash.py');
const RESOLVER = join(REPO, 'scripts', 'review_attest_marker_resolve.py');

// Run gate_config_hash.py <root> <manifest>; return { code, out }.
function cfgHash(root, manifest) {
  try {
    const out = execFileSync('python3', [CFGHASH, root, manifest], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

// A throwaway root with a manifest + optionally its listed files present.
function cfgFixture(manifestLines, presentFiles) {
  const root = mkdtempSync(join(tmpdir(), 'xls1778-cfg-'));
  const man = join(root, 'manifest.txt');
  writeFileSync(man, manifestLines.join('\n') + '\n');
  for (const f of (presentFiles || [])) {
    const p = join(root, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `content-of-${f}\n`);
  }
  return { root, man };
}

// ── Finding 2 (read side): gate_config_hash.py path-traversal containment, rejection-only ──
test('config_hash: valid relative manifest → 64-hex digest, deterministic (byte-identical lockstep)', () => {
  const { root, man } = cfgFixture(['a/one.txt', 'b/two.txt'], ['a/one.txt', 'b/two.txt']);
  const r1 = cfgHash(root, man);
  const r2 = cfgHash(root, man);
  assert.strictEqual(r1.code, 0, r1.out);
  assert.match(r1.out.trim(), /^[0-9a-f]{64}$/);
  assert.strictEqual(r1.out, r2.out, 'digest must be deterministic for a valid manifest');
});

test('config_hash: absolute manifest entry → refused (traversal guard, fail closed)', () => {
  const { root, man } = cfgFixture(['/etc/passwd'], []);
  const r = cfgHash(root, man);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /absolute \(path traversal\)/);
});

test('config_hash: ..-escape manifest entry → refused (traversal guard, fail closed)', () => {
  const { root, man } = cfgFixture(['../../../etc/passwd'], []);
  const r = cfgHash(root, man);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /escapes repo root \(path traversal\)/);
});

test('config_hash: a listed file absent → RAISES (fail closed, not an empty hash)', () => {
  const { root, man } = cfgFixture(['a/present.txt', 'b/absent.txt'], ['a/present.txt']);
  const r = cfgHash(root, man);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /absent/);
});

// ── Findings 1 & 4 (write side, bash): base-ref manifest resolution ──
// A repo whose BASE commit carries .github/review-gate/config-manifest.txt + (optionally) its files.
function makeRepoWithManifest(manifestLines, presentFiles) {
  const rd = mkdtempSync(join(tmpdir(), 'xls1778-mrepo-'));
  const g = (...a) => execFileSync('git', ['-C', rd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a],
    { encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(rd, '.github', 'review-gate'), { recursive: true });
  writeFileSync(join(rd, '.github/review-gate/config-manifest.txt'), manifestLines.join('\n') + '\n');
  for (const f of (presentFiles || [])) {
    const p = join(rd, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `content-of-${f}\n`);
  }
  g('add', '-A'); g('commit', '-q', '-m', 'c1-manifest');
  const base = g('rev-parse', 'HEAD').trim();
  writeFileSync(join(rd, 'f.txt'), 'changed\n');
  g('add', '-A'); g('commit', '-q', '-m', 'c2');
  const head = g('rev-parse', 'HEAD').trim();
  return { dir: rd, base, head };
}

// Drive the gate through the base-ref config-hash resolution (GATE_CONFIG_HASH unset).
function runConfigResolve(repo) {
  const bin = mkdtempSync(join(tmpdir(), 'xls1778-cfgbin-'));
  writeFileSync(join(bin, 'gh'),
    `#!/usr/bin/env bash\nargs="$*"\n` +
    `if printf '%s' "$args" | grep -q 'commits/.*/pulls'; then\n` +
    `  echo '[{"number":1,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${repo.head}"},"base":{"sha":"${repo.base}"}}]'\n` +
    `  exit 0\nfi\nif printf '%s' "$args" | grep -q 'issues/.*/comments'; then exit 0; fi\nexit 0\n`);
  writeFileSync(join(bin, 'cosign'), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755); chmodSync(join(bin, 'cosign'), 0o755);
  const jsonAllow = join(bin, 'allow.json');
  writeFileSync(jsonAllow, JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com', allowed_signer_identities: [SIGNER],
  }));
  try {
    const out = execFileSync('bash', [GATE], {
      cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, ATTESTATION_VERIFY_MODE: 'enforce',
        GITHUB_REPOSITORY: 'senoff/xlsx-for-ai', GITHUB_SHA: repo.head, COSIGN_IDENTITY: SIGNER,
        ATTESTATION_ALLOWLIST: jsonAllow,
        GATE_CONFIG_MANIFEST: '.github/review-gate/config-manifest.txt', GATE_CONFIG_HASH: '',
      },
    });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('base-ref config: manifest entry with .. → refused before publish (traversal guard, fail closed)', () => {
  const repo = makeRepoWithManifest(['../../../etc/passwd'], []);
  const r = runConfigResolve(repo);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /path-traversal guard/);
});

test('base-ref config: a listed file absent at base → refused, never an empty-hash proceed', () => {
  const repo = makeRepoWithManifest(['.github/review-gate/present.json', '.github/review-gate/absent.json'],
    ['.github/review-gate/present.json']);
  const r = runConfigResolve(repo);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /not fully measurable|absent at base/);
});

// ── Finding 3 + OIDC wiring: resolver gh timeout/retry + --expect-issuer pin ──
function runResolver(args, env) {
  try {
    const out = execFileSync('python3', [RESOLVER, ...args],
      { encoding: 'utf8', env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('resolver --expect-issuer: allowlist issuer ≠ pinned issuer → fail-closed (exit 3)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'xls1778-res-'));
  const allow = join(bin, 'allow.json');
  writeFileSync(allow, JSON.stringify({
    oidc_issuer: 'https://evil.example/oidc', allowed_signer_identities: [SIGNER],
  }));
  const out = join(bin, 'pred.json');
  const r = runResolver(['--candidate-cid', CID, '--allowlist', allow, '--marker', '/dev/null',
    '--out', out, '--expect-issuer', 'https://token.actions.githubusercontent.com']);
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /pinned expected issuer/);
});

test('resolver gh api: persistent failure → RAISES fail-closed (timeout/retry, not a hang)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'xls1778-ghfail-'));
  const allow = join(bin, 'allow.json');
  writeFileSync(allow, JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com', allowed_signer_identities: [SIGNER],
  }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const out = join(bin, 'pred.json');
  const r = runResolver(
    ['--repo', 'senoff/xlsx-for-ai', '--pr', '7', '--candidate-cid', CID, '--allowlist', allow, '--out', out],
    { PATH: `${bin}:${process.env.PATH}`, GH_API_RETRY_BACKOFF: '0', GH_API_TRIES: '3' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /gh api read failed after 3 attempts/);
});

// ── grace-review re-review (8b26f75): base-only guarantee for the signer allowlist ──
// A repo-relative allowlist that is ABSENT at base but present on the PR HEAD checkout must NOT be
// read from HEAD (that would let a same-PR edit self-waive the signer set). Fail-closed.
test('allowlist: repo-relative + absent at base (present only on HEAD) → refused (base-only, fail closed)', () => {
  const repo = makeRepo(true); // non-empty diff → a real CONTENT_ID; allowlist NOT committed at base
  const relAllow = 'signer-allowlist.json';
  writeFileSync(join(repo.dir, relAllow), JSON.stringify({
    oidc_issuer: 'https://token.actions.githubusercontent.com', allowed_signer_identities: [SIGNER],
  })); // written into the working tree only — untracked, so `git show BASE:` misses it
  const bin = mkdtempSync(join(tmpdir(), 'xls1778-baseonly-'));
  writeFileSync(join(bin, 'gh'),
    `#!/usr/bin/env bash\nargs="$*"\n` +
    `if printf '%s' "$args" | grep -q 'commits/.*/pulls'; then\n` +
    `  echo '[{"number":1,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${repo.head}"},"base":{"sha":"${repo.base}"}}]'\n` +
    `  exit 0\nfi\nexit 0\n`);
  writeFileSync(join(bin, 'cosign'), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755); chmodSync(join(bin, 'cosign'), 0o755);
  let r;
  try {
    execFileSync('bash', [GATE], {
      cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, ATTESTATION_VERIFY_MODE: 'enforce',
        GITHUB_REPOSITORY: 'senoff/xlsx-for-ai', GITHUB_SHA: repo.head, COSIGN_IDENTITY: SIGNER,
        ATTESTATION_ALLOWLIST: relAllow,      // repo-relative, absent at base, present on HEAD
        GATE_CONFIG_HASH: 'cfg-seam',          // skip base-ref config resolution
      },
    });
    r = { code: 0, out: '' };
  } catch (e) { r = { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /absent at the base ref|Refusing to publish/);
});
