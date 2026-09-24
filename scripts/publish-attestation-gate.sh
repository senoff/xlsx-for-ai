#!/usr/bin/env bash
# publish-attestation-gate.sh — the npm publish gate, replacing the grace-review receipt
# check with the NEW workflow-attestation receipt (XLS-1778, gate cutover card F).
#
# Build authority: /root/work/state/proposals/rfc-v3-gate-cards.md §14.F + §13.1 (the
# attestation predicate) + the GLOBAL CONSTRAINTS (fail-closed everywhere; no key wired
# until Bob authorizes — the live crypto path is built against fixtures, real keys arrive
# as a go-live checklist item). Canonical = the sysarch RFC v3; feasibility → sysarch.
#
# WHAT CHANGED. The old publish gate refused a publish only when the prior review panel kept a
# CRITICAL. This gate does not read that verdict at all: publish is allowed ONLY when a valid
# NEW-GATE attestation (§13.1) exists for the EXACT content being published — the two live
# reviewers both passed, the attestation is signed by an allowlisted workflow identity, and its
# subject_content_id equals the CONTENT_ID recomputed from what main carries. A superseded
# grace-style receipt is REFUSED, not honored (no carry-over of the old signatures — RFC cutover
# note). The publish-path detach-guard keeps the old gate's tooling out of this path.
#
# DELIVERY = signed COMMENT-MARKER (SysArch Confirm #2, 2026-09-24): the attestation is card A's
# `review-attest-marker:` comment on the reviewed PR (base64 blob=canonical §13.1 predicate +
# bundle=cosign keyless bundle), NOT a build-artifact triplet. F resolves the marker; it does not
# download an artifact.
#
# §13.1 PREDICATE (ALL must hold, else REFUSE — fail closed):
#   1. predicate present, non-empty, valid JSON
#   2. NOT grace-style (no `grace…` schema, not a grace-override-receipt shape)
#   3. predicate_type == the §13.1 version this gate implements (pinned; unknown ⇒ closed)
#   4. verdict == "pass"                       (any other value or absence ⇒ RED)
#   5. subject_content_id == recomputed candidate CONTENT_ID (the exact published content)
#   6. signer_identity ∈ the allowlist AND == the keyless cert identity (a non-allowlisted or
#      signature-unbound signer ⇒ RED)
#   7. both LIVE reviewer slots present-and-passed (slot A + slot B in reviewer_slots;
#      rungs_passed ⊇ {stage0, reviewerA, reviewerB})
#   8. config_hash == the current gate config hash (a stale-config attestation is a miss)
#   9. LIVE MODE ONLY: the marker's cosign keyless signature verifies against the EXACT allowlisted
#      OIDC identity. This is the crypto trust root; with no verify tooling / identity configured
#      it FAILS CLOSED (never a skip-to-pass). Exercised against fixtures in tests.
#
# MODES:
#   --receipt-file <path> --expect-content-id <cid> [--allowlist <file>] [--config-hash <h>]
#       Deterministic decision seam — the §14.F RED-arm witness. Runs the §13.1 predicate judge
#       decide() over a local predicate with NO network and NO crypto: valid ⇒ exit 0;
#       missing/mismatched/grace-style ⇒ exit 1.
#   (live, default) resolve GITHUB_SHA → its PR (base + head) → recompute CONTENT_ID over
#       base...head via scripts/content_id.py → resolve card A's signed review-attest-marker for
#       that CONTENT_ID (scripts/review_attest_marker_resolve.py: cosign keyless verify against the
#       EXACT allowlisted identity) → decide(). Fail closed on any gap.
#
# Exit: 0 = publish may proceed · 1 = REFUSE (fail closed) · 2 = usage error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── contract values from the SysArch Integration Contract (rfc-v3-gate-cards.md §13.1 / §142+;
#    2026-09-24 F ruling) — env-overridable, each with a FAIL-CLOSED default ──────────
# These seam values are shared across cards A (sign) ↔ C (mint) ↔ F (this gate). Where a value
# is OWNED by card A's landed implementation, F takes A's value verbatim and does NOT hardcode a
# divergent one. Per the F ruling, F takes exactly two values from A's landed gate config — the
# exact allowlist PATH and the shared gate_config_hash HELPER — and the cosign identity is the
# EXACT base-ref workflow identity (never a broad regexp — a wildcard that could match a
# PR-head-controlled or foreign workflow is the fail-open guard SysArch calls the highest risk).
# DELIVERY = signed COMMENT-MARKER (SysArch Confirm #2, 2026-09-24): card A posts a
# `review-attest-marker:` comment on the reviewed PR (base64 {blob_b64=canonical §13.1 predicate,
# bundle_b64=cosign keyless bundle}). F resolves it — it does NOT download a build artifact.
ATTESTATION_SCHEMA="${ATTESTATION_SCHEMA:-review-attestation/1}"   # §13.1 predicate_type — CONFIRMED canonical
# ATTESTATION_ALLOWLIST — A's exact PATH: the signer-allowlist JSON, read from the BASE REF; F
# parses {oidc_issuer, allowed_signer_identities:[...]} (A's shape).
ATTESTATION_ALLOWLIST="${ATTESTATION_ALLOWLIST:-.github/review-gate/signer-allowlist.json}"
# GATE_CONFIG_MANIFEST — the CODEOWNERS-protected gate-config file SET whose sha256 is the
# config_hash; F folds it through the SHARED helper (scripts/gate_config_hash.py, a vendored copy
# of A's review_attest_lib.config_hash — NOT a reimplementation) from the BASE REF. A precomputed
# GATE_CONFIG_HASH (env) still overrides for the deterministic seam. A stale-config attestation is
# a miss. ATTESTATION_VERIFY_MODE=enforce turns on the live cosign verify (default `enforce`).
GATE_CONFIG_MANIFEST="${GATE_CONFIG_MANIFEST:-.github/review-gate/config-manifest.txt}"
# COSIGN identity/issuer — the EXACT base-ref signer-workflow identity (no broad regexp — a
# wildcard that could match a PR-head-controlled or foreign workflow is the fail-open guard) + the
# definitive GitHub Actions OIDC issuer. Post-rename canonical (card A) for THIS repo. Overridable.
COSIGN_IDENTITY="${COSIGN_IDENTITY:-https://github.com/senoff/xlsx-for-ai/.github/workflows/review-gate.yml@refs/heads/main}"
COSIGN_OIDC_ISSUER="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "::error::required tool '$1' not found on the runner. Refusing to publish (fail closed)."; exit 1; }; }

# Redact token-shaped strings from any diagnostic before it reaches a public Actions log.
gh_redact() {
  sed -E 's/(gh[posru]_|github_pat_)[A-Za-z0-9_]+/\1***REDACTED***/g; s/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1***REDACTED***/g'
}

# Sanitize a RECEIPT-controlled value before echoing it into a (public) Actions annotation: the
# receipt is attacker-influenceable JSON, so strip CR/LF (log-line spoofing) and neutralize the
# `::` workflow-command prefix (annotation/command injection), and cap the length. Used for DISPLAY
# only — the raw value is what the predicate compares, so this never loosens a check (a doctored
# value still fails the compare and is refused).
disp() { printf '%s' "${1:-}" | tr -d '\r\n' | sed 's/::/:\xE2\x80\x8b:/g' | cut -c1-160; }

# gh api with bounded retry/backoff + a per-call timeout (mirrors the grace gate: a transient
# hiccup must not fail-closed a legitimate publish; a persistent failure still fails closed).
gh_api() {
  local attempt rc=1 errf; errf="$(mktemp)"
  for attempt in 1 2 3 4; do
    timeout 60 gh api "$@" 2>"$errf" && { rm -f "$errf"; return 0; }
    rc=$?; [ "$attempt" -lt 4 ] && sleep $((attempt * 2))
  done
  echo "::error::gh api failed after retries (rc=${rc}); redacted stderr tail follows:" >&2
  gh_redact < "$errf" | tail -3 >&2
  rm -f "$errf"
  return "$rc"
}

# ── grace-style guard: a grace receipt is REFUSED, never honored (RFC cutover note) ──
is_grace_style() {  # is_grace_style <receipt.json> -> 0 if it looks like a grace receipt
  local f="$1" schema sev subj
  schema="$(jq -r '.schema // ""' "$f" 2>/dev/null || echo "")"
  case "$schema" in grace*|*grace-override-receipt*) return 0 ;; esac
  # Structural: a grace-override-receipt carries `.severity` and has NO §13.1 subject.
  sev="$(jq -r 'has("severity")' "$f" 2>/dev/null || echo "false")"
  subj="$(jq -r 'has("subject_content_id")' "$f" 2>/dev/null || echo "false")"
  [ "$sev" = "true" ] && [ "$subj" != "true" ] && return 0
  return 1
}

# ── signer allowlist membership — A's canonical shape is the JSON signer-allowlist ────
# A's allowlist (.github/review-gate/signer-allowlist.json) is
#   { "oidc_issuer": "...", "allowed_signer_identities": ["<exact base-ref workflow identity>", ...] }
# F reads that exact PATH from the BASE REF and checks membership against
# `allowed_signer_identities` (exact match; never a regexp). A legacy one-identity-per-line file
# is still accepted (fallback) so the deterministic seam stays simple.
allowlist_has() {  # allowlist_has <allowlist-file> <signer> -> 0 if signer is allowlisted
  local allow="$1" signer="$2"
  [ -n "$signer" ] || return 1
  if jq -e 'has("allowed_signer_identities")' "$allow" >/dev/null 2>&1; then
    jq -e --arg s "$signer" '(.allowed_signer_identities // []) | index($s) != null' \
       "$allow" >/dev/null 2>&1
    return $?
  fi
  grep -qxF "$signer" "$allow"
}

# ── decide(): the ONE place the §13.1 marker predicate becomes a publish verdict ──────
# decide <predicate.json> <expected-content-id> [allowlist-file] [config-hash] [cert-identity]
# Mirrors card A's review_attest_lib.verify_predicate (subject/verdict/slots/config_hash/signer)
# plus F's grace-style refusal and the predicate_type pin. `cert-identity` is the identity the
# keyless SIGNATURE actually bound (from marker resolution); when omitted (the crypto-free seam)
# it defaults to the predicate's declared signer_identity so the declared==cert check is a no-op.
decide() {
  local f="$1" want_cid="$2" allow="${3:-}" want_cfg="${4:-}" cert="${5:-}"
  local ptype verdict subj signer cfg
  if [ ! -s "$f" ]; then
    echo "::error::attestation predicate missing or empty ($f) — cannot certify this content was reviewed. Refusing to publish (fail closed)."
    exit 1
  fi
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "::error::attestation predicate ($f) is not valid JSON. Refusing to publish (fail closed)."
    exit 1
  fi
  # (2) grace-style receipt is REFUSED — the old grace attestation is not honored.
  if is_grace_style "$f"; then
    echo "::error::this is a GRACE-style receipt (grace-override-receipt). The grace attestation is not honored under the new gate — re-run through the review gate to mint a workflow attestation. Refusing to publish (fail closed)."
    exit 1
  fi
  # (3) predicate_type pinned to the §13.1 version this gate implements (card A stamps it).
  ptype="$(jq -r '.predicate_type // ""' "$f" 2>/dev/null || echo "")"
  if [ "$ptype" != "$ATTESTATION_SCHEMA" ]; then
    echo "::error::attestation predicate_type '$(disp "$ptype")' is not '${ATTESTATION_SCHEMA}' (the version this gate implements) — refusing to publish (fail closed). Update publish-attestation-gate.sh for the new predicate contract."
    exit 1
  fi
  # (4) verdict must be exactly "pass".
  verdict="$(jq -r '.verdict // ""' "$f" 2>/dev/null || echo "")"
  if [ "$verdict" != "pass" ]; then
    echo "::error::attestation verdict='$(disp "${verdict:-<absent>}")' (only \"pass\" is landable) — refusing to publish (fail closed)."
    exit 1
  fi
  # (5) subject_content_id == the recomputed candidate CONTENT_ID (exact published content).
  subj="$(jq -r '.subject_content_id // ""' "$f" 2>/dev/null || echo "")"
  if [ -z "$subj" ] || [ "$subj" != "$want_cid" ]; then
    echo "::error::attestation subject_content_id='$(disp "${subj:-<absent>}")' does not equal the published content's CONTENT_ID='${want_cid}' — the attestation does not answer for THIS content (mismatch). Refusing to publish (fail closed)."
    exit 1
  fi
  # (6) signer_identity ∈ allowlist (when an allowlist is provided; live mode requires one), AND
  #     the declared signer_identity == the identity the keyless SIGNATURE actually bound (cert).
  signer="$(jq -r '.signer_identity // ""' "$f" 2>/dev/null || echo "")"
  [ -n "$cert" ] || cert="$signer"   # crypto-free seam: assume the signature bound the declared id
  if [ "$signer" != "$cert" ]; then
    echo "::error::attestation signer_identity='$(disp "${signer:-<absent>}")' != the keyless certificate identity='$(disp "$cert")' (the signature did not bind the declared signer) — refusing to publish (fail closed)."
    exit 1
  fi
  if [ -n "$allow" ]; then
    if [ ! -s "$allow" ]; then
      echo "::error::signer allowlist '${allow}' missing or empty — cannot certify the signer. Refusing to publish (fail closed)."
      exit 1
    fi
    if ! allowlist_has "$allow" "$signer"; then
      echo "::error::attestation signer_identity='$(disp "${signer:-<absent>}")' is not in the allowlist — refusing to publish (fail closed)."
      exit 1
    fi
  elif [ -z "$signer" ]; then
    echo "::error::attestation carries no signer_identity — refusing to publish (fail closed)."
    exit 1
  fi
  # (7) both LIVE reviewer slots present-and-passed.
  local hasA hasB rungs
  hasA="$(jq -r '[.reviewer_slots[]? | select(startswith("A:"))] | length' "$f" 2>/dev/null || echo 0)"
  hasB="$(jq -r '[.reviewer_slots[]? | select(startswith("B:"))] | length' "$f" 2>/dev/null || echo 0)"
  if [ "${hasA:-0}" -lt 1 ] || [ "${hasB:-0}" -lt 1 ]; then
    echo "::error::attestation is missing a live reviewer slot (need both A: and B: in reviewer_slots; got A=${hasA} B=${hasB}) — refusing to publish (fail closed)."
    exit 1
  fi
  for rung in stage0 reviewerA reviewerB; do
    rungs="$(jq -r --arg r "$rung" '[.rungs_passed[]? | select(. == $r)] | length' "$f" 2>/dev/null || echo 0)"
    if [ "${rungs:-0}" -lt 1 ]; then
      echo "::error::attestation rungs_passed is missing '${rung}' (need stage0 + both reviewers) — refusing to publish (fail closed)."
      exit 1
    fi
  done
  # (8) config_hash == current gate config hash (a stale-config attestation is a miss).
  if [ -n "$want_cfg" ]; then
    cfg="$(jq -r '.config_hash // ""' "$f" 2>/dev/null || echo "")"
    if [ -z "$cfg" ] || [ "$cfg" != "$want_cfg" ]; then
      echo "::error::attestation config_hash='$(disp "${cfg:-<absent>}")' does not equal the current gate config hash — the review ran under stale gate config (a miss). Refusing to publish (fail closed)."
      exit 1
    fi
  fi
  echo "attestation OK: verdict=pass, signer allowlisted, subject_content_id matches the published CONTENT_ID, both live reviewers passed$( [ -n "$want_cfg" ] && echo ", config current"). Publish may proceed."
  exit 0
}

# ── arg parse: deterministic test seam ───────────────────────────────────────────────
if [ "${1:-}" = "--receipt-file" ]; then
  need jq
  RF=""; CID=""; ALLOW=""; CFG=""
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect-content-id) CID="${2:-}"; shift 2 ;;
      --allowlist) ALLOW="${2:-}"; shift 2 ;;
      --config-hash) CFG="${2:-}"; shift 2 ;;
      --*) echo "unknown flag: $1" >&2; exit 2 ;;
      *) RF="$1"; shift ;;
    esac
  done
  [ -n "$RF" ] || { echo "usage: $0 --receipt-file <attestation.json> --expect-content-id <cid> [--allowlist <f>] [--config-hash <h>]" >&2; exit 2; }
  [ -n "$CID" ] || { echo "::error::--expect-content-id is required (the deterministic seam verifies the attestation answers for a SPECIFIC content id). Refusing (fail closed)." >&2; exit 1; }
  decide "$RF" "$CID" "$ALLOW" "$CFG"
fi

# ── live mode ─────────────────────────────────────────────────────────────────────────
need gh; need jq; need timeout; need python3; need git
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required in live mode}"
SHA="${GITHUB_SHA:?GITHUB_SHA is required in live mode}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
VERIFY_MODE="${ATTESTATION_VERIFY_MODE:-enforce}"
ALLOWLIST="${ATTESTATION_ALLOWLIST:-}"
CONFIG_HASH="${GATE_CONFIG_HASH:-}"

# The live signature verify is the crypto trust root. Until card A wires the cosign keyless
# identity + secrets (a go-live checklist item — "no key until Bob"), enforce mode has no
# verifier and MUST fail closed. It never skips-to-pass.
if [ "$VERIFY_MODE" = "enforce" ]; then
  if ! command -v cosign >/dev/null 2>&1; then
    echo "::error::live signature verify is enforced but 'cosign' is not on the runner. The new gate is not yet wired for live crypto (card A go-live). Refusing to publish (fail closed)."
    exit 1
  fi
  # The cosign identity is the EXACT base-ref signer workflow identity (SysArch F ruling): a
  # broad regexp that could match a PR-head-controlled or foreign workflow is the fail-OPEN guard.
  if [ -z "${COSIGN_IDENTITY:-}" ]; then
    echo "::error::live verify is enforced but COSIGN_IDENTITY (the EXACT base-ref signer workflow identity) is unset — refusing to publish (fail closed). A broad certificate-identity regexp is not accepted."
    exit 1
  fi
  if [ -z "$ALLOWLIST" ]; then
    echo "::error::live verify is enforced but ATTESTATION_ALLOWLIST (the signer-allowlist path) is unset. Refusing to publish (fail closed)."
    exit 1
  fi
  # config_hash presence is enforced AFTER the base ref is known (it is resolved from the base
  # ref via the shared helper unless a GATE_CONFIG_HASH override is supplied) — see below.
fi

# Map the release commit on protected main back to its PR (base + head sha). The subject the
# attestation signed is CONTENT_ID over base...head; recompute it and require an exact match.
PR_JSON="$(gh_api "repos/${REPO}/commits/${SHA}/pulls" || true)"
if [ -z "$PR_JSON" ]; then
  echo "::error::could not query pull requests for commit ${SHA} (after retries). Refusing to publish (fail closed)."
  exit 1
fi
read -r PR_NUM HEAD_SHA BASE_SHA < <(printf '%s' "$PR_JSON" | jq -r '
  ((([.[] | select(.merged_at != null)] | sort_by(.merged_at) | last) // .[0]) // {})
  | "\(.number // "") \(.head.sha // "") \(.base.sha // "")"')
if [ -z "${HEAD_SHA:-}" ] || [ -z "${PR_NUM:-}" ] || [ -z "${BASE_SHA:-}" ]; then
  echo "::error::no pull request (with base+head) found for commit ${SHA} — cannot locate/verify its attestation. Every release lands via a reviewed PR. Refusing to publish (fail closed)."
  exit 1
fi

# Recompute the candidate CONTENT_ID over base...head using the vendored canonical recipe.
CID="$(python3 "${HERE}/content_id.py" "." "${BASE_SHA}" "${HEAD_SHA}" || true)"
if [ -z "$CID" ]; then
  echo "::error::could not recompute CONTENT_ID for ${BASE_SHA}...${HEAD_SHA} (empty diff or git fault) — cannot check the attestation answers for this content. Refusing to publish (fail closed)."
  exit 1
fi

# ── resolve the gate config from the BASE REF, never PR HEAD (SysArch D-2 / F ruling) ──
# The signer allowlist and the config-hash file set are read from the base ref so a same-PR
# self-waiver (editing the allowlist / a gate-config file on HEAD) cannot take effect.
BASEREF_DIR="$(mktemp -d)"
trap 'rm -rf "$BASEREF_DIR" ${TMP:+"$TMP"}' EXIT

# (a) signer allowlist — A's exact PATH, materialized from the base ref. An absolute/local path
#     (e.g. a test fixture) that is not tracked at base is used as-is.
if git show "${BASE_SHA}:${ALLOWLIST}" > "${BASEREF_DIR}/signer-allowlist.json" 2>/dev/null \
     && [ -s "${BASEREF_DIR}/signer-allowlist.json" ]; then
  ALLOWLIST="${BASEREF_DIR}/signer-allowlist.json"
elif [ ! -s "$ALLOWLIST" ]; then
  ALLOWLIST=""
fi
if [ "$VERIFY_MODE" = "enforce" ] && { [ -z "$ALLOWLIST" ] || [ ! -s "$ALLOWLIST" ]; }; then
  echo "::error::signer allowlist ('${ATTESTATION_ALLOWLIST}') is absent at the base ref ${BASE_SHA} — the gate config is not present, so no signer can be certified. Refusing to publish (fail closed)."
  exit 1
fi

# (b) config_hash — an explicit GATE_CONFIG_HASH override wins (the deterministic seam); otherwise
#     fold the manifest's CODEOWNERS-protected file set through the SHARED helper from the base ref
#     (scripts/gate_config_hash.py — a vendored copy of A's review_attest_lib.config_hash, NOT a
#     reimplementation). A stale/absent gate config => empty hash => fail-closed below.
if [ -z "$CONFIG_HASH" ] && git cat-file -e "${BASE_SHA}:${GATE_CONFIG_MANIFEST}" 2>/dev/null; then
  if ! git show "${BASE_SHA}:${GATE_CONFIG_MANIFEST}" > "${BASEREF_DIR}/config-manifest.txt" 2>/dev/null; then
    echo "::error::gate config manifest '${GATE_CONFIG_MANIFEST}' could not be materialized from base ${BASE_SHA} — the config surface is not measurable. Refusing to publish (fail closed)."
    exit 1
  fi
  while IFS= read -r rawrel || [ -n "$rawrel" ]; do
    rel="$(printf '%s' "$rawrel" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$rel" in ''|'#'*) continue ;; esac
    # Path-traversal guard (SPM re-review): a manifest entry must be a repo-relative, ..-free path.
    # An absolute path or a `..` segment would let a HEAD-authored manifest write OUTSIDE the sandbox
    # (arbitrary-file truncation) on the npm-OIDC publish runner. Refuse — never `|| true` past it.
    case "$rel" in
      /*|../*|*/../*|*/..|..)
        echo "::error::gate config manifest entry '${rel}' is not a repo-relative, ..-free path — refusing to publish (path-traversal guard, fail closed)."
        exit 1 ;;
    esac
    mkdir -p "${BASEREF_DIR}/$(dirname "$rel")"
    # A file listed in the manifest but ABSENT at base = an unmeasurable config surface. Materialize
    # via a temp file and keep it only on success; a missing blob must RAISE (fail closed), never
    # leave an empty stub that gate_config_hash.py would then hash as '' instead of raising.
    if ! git show "${BASE_SHA}:${rel}" > "${BASEREF_DIR}/${rel}.materializing" 2>/dev/null; then
      rm -f "${BASEREF_DIR}/${rel}.materializing"
      echo "::error::gate config file '${rel}' listed in the manifest is absent at base ${BASE_SHA} — the config surface is not fully measurable. Refusing to publish (fail closed)."
      exit 1
    fi
    mv "${BASEREF_DIR}/${rel}.materializing" "${BASEREF_DIR}/${rel}"
  done < "${BASEREF_DIR}/config-manifest.txt"
  CONFIG_HASH="$(python3 "${HERE}/gate_config_hash.py" "${BASEREF_DIR}" "${BASEREF_DIR}/config-manifest.txt" 2>/dev/null || true)"
fi
# §8 predicate: a stale-config attestation is a miss. In enforce mode the hash MUST be determinable
# (SPM fail-open fix #1: an unset config-hash must never silently skip the staleness check).
if [ "$VERIFY_MODE" = "enforce" ] && [ -z "$CONFIG_HASH" ]; then
  echo "::error::live verify is enforced but the gate config hash could not be determined (GATE_CONFIG_HASH unset AND the config manifest '${GATE_CONFIG_MANIFEST}' is absent at base ${BASE_SHA}) — a review under stale/absent gate config would pass. Refusing to publish (fail closed)."
  exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$BASEREF_DIR" "$TMP"' EXIT

# Resolve card A's signed COMMENT-MARKER on the merged PR (SysArch Confirm #2 — delivery is a
# marker, NOT a build artifact). The resolver (scripts/review_attest_marker_resolve.py) reads every
# `review-attest-marker:` comment on PR #${PR_NUM}, cosign-verifies each keyless bundle against the
# EXACT allowlisted identity + issuer, keeps only those whose predicate's subject_content_id == the
# recomputed CONTENT_ID, and returns the LATEST such predicate (a later unsigned/tampered line can
# never override an earlier signed one). The trust DECISION stays in decide() — the one judge.
ATT="${TMP}/predicate.json"
CERT_IDENTITY=""
resolve_marker() {  # resolve_marker <extra-args...> ; sets CERT_IDENTITY, writes $ATT; returns rc
  local rc
  CERT_IDENTITY="$(python3 "${HERE}/review_attest_marker_resolve.py" \
      --repo "$REPO" --pr "$PR_NUM" --candidate-cid "$CID" \
      --allowlist "$ALLOWLIST" --out "$ATT" "$@" 2>"${TMP}/resolve.err")"; rc=$?
  gh_redact < "${TMP}/resolve.err" >&2 || true   # surface diagnostics (token-redacted)
  return "$rc"
}

if [ "$VERIFY_MODE" = "enforce" ]; then
  # cosign-verify the marker's keyless bundle against the EXACT allowlisted identity + issuer.
  if ! COSIGN_IDENTITY_EXPECT="$COSIGN_IDENTITY" resolve_marker \
        --expect-issuer "$COSIGN_OIDC_ISSUER" \
        --cosign "${COSIGN_BIN:-cosign}" ${COSIGN_IGNORE_TLOG:+--ignore-tlog}; then
    echo "::error::no authentic review-attest-marker for PR #${PR_NUM} head ${HEAD_SHA} attesting CONTENT_ID ${CID} — the review gate never posted a valid signed attestation for this content. Refusing to publish (fail closed)."
    exit 1
  fi
  if [ ! -s "$ATT" ] || [ -z "$CERT_IDENTITY" ]; then
    echo "::error::marker resolution did not yield a signed predicate + cert identity for CONTENT_ID ${CID}. Refusing to publish (fail closed)."
    exit 1
  fi
  # The resolver pins cosign --certificate-identity to each allowlisted id; require the one it
  # verified to be exactly the configured signer identity (defense-in-depth over the allowlist).
  if [ "$CERT_IDENTITY" != "$COSIGN_IDENTITY" ]; then
    echo "::error::marker was signed by '$(disp "$CERT_IDENTITY")', not the pinned signer identity '${COSIGN_IDENTITY}' — refusing to publish (fail closed)."
    exit 1
  fi
  echo "review-attest-marker verified for PR #${PR_NUM} (cosign identity ${CERT_IDENTITY}); recomputed CONTENT_ID ${CID}."
else
  # permissive (non-enforce) diagnostic path only — never the live publish posture (enforce is the
  # default). Resolution still fails closed if no marker for this content exists.
  resolve_marker || { echo "::error::no resolvable review-attest-marker for CONTENT_ID ${CID} (permissive). Refusing to publish (fail closed)."; exit 1; }
  [ -s "$ATT" ] || { echo "::error::no marker predicate resolved (permissive). Refusing (fail closed)."; exit 1; }
fi

decide "$ATT" "$CID" "$ALLOWLIST" "$CONFIG_HASH" "$CERT_IDENTITY"
