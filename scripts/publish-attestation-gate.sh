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
# §13.1 PREDICATE (ALL must hold, else REFUSE — fail closed):
#   1. receipt present, non-empty, valid JSON
#   2. NOT grace-style (no `grace…` schema, not a grace-override-receipt shape)
#   3. schema == the new attestation schema this gate implements (pinned; unknown ⇒ closed)
#   4. verdict == "pass"                       (any other value or absence ⇒ RED)
#   5. subject_content_id == recomputed candidate CONTENT_ID (the exact published content)
#   6. signer_identity ∈ the allowlist          (a non-allowlisted signer ⇒ RED)
#   7. both LIVE reviewer slots present-and-passed (slot A + slot B in reviewer_slots;
#      rungs_passed ⊇ {stage0, reviewerA, reviewerB})
#   8. config_hash == the current gate config hash (a stale-config attestation is a miss)
#   9. LIVE MODE ONLY: the cosign keyless signature verifies against the allowlisted OIDC
#      identity. This is the crypto trust root; with no verify tooling / identity configured
#      it FAILS CLOSED (never a skip-to-pass). Exercised against fixtures in tests.
#
# MODES:
#   --receipt-file <path> --expect-content-id <cid> [--allowlist <file>] [--config-hash <h>]
#       Deterministic decision seam — the §14.F RED-arm witness. Runs the §13.1 predicate
#       over a local receipt with NO network and NO crypto (the same posture the grace gate's
#       --receipt-file seam had): valid ⇒ exit 0; missing/mismatched/grace-style ⇒ exit 1.
#   (live, default) resolve GITHUB_SHA → its PR (base + head) → recompute CONTENT_ID over
#       base...head via scripts/content_id.py → locate the review workflow's attestation for
#       the head sha → cosign-verify → decide(). Fail closed on any gap.
#
# Exit: 0 = publish may proceed · 1 = REFUSE (fail closed) · 2 = usage error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── contract values owned by cutover card A (env-overridable; GO-LIVE checklist) ─────
# The new attestation schema token, the review workflow that MINTS the attestation, the
# allowlisted OIDC signer identity, and the current gate config hash are all fixed by
# card A's landed gate config. They are read from the environment so this gate does not
# hard-code a value A may finalize; each has a fail-closed default (an unset required
# value REFUSES, it never passes).
ATTESTATION_SCHEMA="${ATTESTATION_SCHEMA:-review-attestation/1}"   # A: the §13.1 receipt schema token
REVIEW_WORKFLOW="${REVIEW_WORKFLOW:-review-gate.yml}"              # A: workflow that uploads the attestation artifact
ATTESTATION_ARTIFACT_PREFIX="${ATTESTATION_ARTIFACT_PREFIX:-review-attestation-}" # + head sha
# ATTESTATION_ALLOWLIST (file, one signer identity per line) and GATE_CONFIG_HASH come
# from A's gate config; ATTESTATION_VERIFY_MODE=enforce turns on the live cosign verify
# (default `enforce` — a live publish must verify the signature; tests pass `skip-crypto`
# via --receipt-file, never here).

need() { command -v "$1" >/dev/null 2>&1 || { echo "::error::required tool '$1' not found on the runner. Refusing to publish (fail closed)."; exit 1; }; }

# Redact token-shaped strings from any diagnostic before it reaches a public Actions log.
gh_redact() {
  sed -E 's/(gh[posru]_|github_pat_)[A-Za-z0-9_]+/\1***REDACTED***/g; s/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1***REDACTED***/g'
}

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

gh_download() {  # gh_download <api-path> <outfile> — binary-safe download with retry
  local path="$1" out="$2" attempt rc=1 tmp="$2.part" errf; errf="$(mktemp)"
  for attempt in 1 2 3 4; do
    : > "$tmp"
    timeout 120 gh api "$path" > "$tmp" 2>"$errf" && { mv -f "$tmp" "$out"; rm -f "$errf"; return 0; }
    rc=$?; rm -f "$tmp"; [ "$attempt" -lt 4 ] && sleep $((attempt * 2))
  done
  echo "::error::gh download failed after retries (rc=${rc}); redacted stderr tail follows:" >&2
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

# ── decide(): the ONE place a §13.1 attestation becomes a publish verdict ────────────
# decide <receipt.json> <expected-content-id> [allowlist-file] [config-hash]
decide() {
  local f="$1" want_cid="$2" allow="${3:-}" want_cfg="${4:-}"
  local schema verdict subj signer cfg
  if [ ! -s "$f" ]; then
    echo "::error::attestation receipt missing or empty ($f) — cannot certify this content was reviewed. Refusing to publish (fail closed)."
    exit 1
  fi
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "::error::attestation receipt ($f) is not valid JSON. Refusing to publish (fail closed)."
    exit 1
  fi
  # (2) grace-style receipt is REFUSED — the old grace attestation is not honored.
  if is_grace_style "$f"; then
    echo "::error::this is a GRACE-style receipt (grace-override-receipt). The grace attestation is not honored under the new gate — re-run through the review gate to mint a workflow attestation. Refusing to publish (fail closed)."
    exit 1
  fi
  # (3) schema pinned to the version this gate implements.
  schema="$(jq -r '.schema // ""' "$f" 2>/dev/null || echo "")"
  if [ "$schema" != "$ATTESTATION_SCHEMA" ]; then
    echo "::error::attestation schema '${schema}' is not '${ATTESTATION_SCHEMA}' (the version this gate implements) — refusing to publish (fail closed). Update publish-attestation-gate.sh for the new receipt contract."
    exit 1
  fi
  # (4) verdict must be exactly "pass".
  verdict="$(jq -r '.verdict // ""' "$f" 2>/dev/null || echo "")"
  if [ "$verdict" != "pass" ]; then
    echo "::error::attestation verdict='${verdict:-<absent>}' (only \"pass\" is landable) — refusing to publish (fail closed)."
    exit 1
  fi
  # (5) subject_content_id == the recomputed candidate CONTENT_ID (exact published content).
  subj="$(jq -r '.subject_content_id // ""' "$f" 2>/dev/null || echo "")"
  if [ -z "$subj" ] || [ "$subj" != "$want_cid" ]; then
    echo "::error::attestation subject_content_id='${subj:-<absent>}' does not equal the published content's CONTENT_ID='${want_cid}' — the attestation does not answer for THIS content (mismatch). Refusing to publish (fail closed)."
    exit 1
  fi
  # (6) signer_identity ∈ allowlist (when an allowlist is provided; live mode requires one).
  signer="$(jq -r '.signer_identity // ""' "$f" 2>/dev/null || echo "")"
  if [ -n "$allow" ]; then
    if [ ! -s "$allow" ]; then
      echo "::error::signer allowlist '${allow}' missing or empty — cannot certify the signer. Refusing to publish (fail closed)."
      exit 1
    fi
    if [ -z "$signer" ] || ! grep -qxF "$signer" "$allow"; then
      echo "::error::attestation signer_identity='${signer:-<absent>}' is not in the allowlist — refusing to publish (fail closed)."
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
      echo "::error::attestation config_hash='${cfg:-<absent>}' does not equal the current gate config hash — the review ran under stale gate config (a miss). Refusing to publish (fail closed)."
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
need gh; need jq; need unzip; need timeout; need python3
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
  if [ -z "$ALLOWLIST" ] || [ ! -s "$ALLOWLIST" ]; then
    echo "::error::live verify is enforced but ATTESTATION_ALLOWLIST (the allowlisted OIDC signer identities) is unset/empty. Refusing to publish (fail closed)."
    exit 1
  fi
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

# Locate the AUTHENTIC attestation: bind to the review workflow's OWN run for this head sha
# (only the repo's review CI produces those), newest run holding a non-expired artifact.
WF_JSON="$(gh_api "repos/${REPO}/actions/workflows/${REVIEW_WORKFLOW}" || true)"
WF_ID="$(printf '%s' "$WF_JSON" | jq -r '.id // empty' 2>/dev/null || echo "")"
if [ -z "$WF_ID" ]; then
  echo "::error::review workflow (${REVIEW_WORKFLOW}) not found in ${REPO} — the new review gate is not present at this head, so no authentic attestation exists. Refusing to publish (fail closed)."
  exit 1
fi
ART_NAME="${ATTESTATION_ARTIFACT_PREFIX}${HEAD_SHA}"
RUN_ID=""; AID=""
while IFS= read -r rid; do
  [ -n "$rid" ] || continue
  cand="$(gh_api "repos/${REPO}/actions/runs/${rid}/artifacts?per_page=100" \
            --jq "[.artifacts[] | select(.name == \"${ART_NAME}\") | select(.expired == false)] | sort_by(.created_at) | last | .id // empty" || true)"
  if [ -n "$cand" ]; then RUN_ID="$rid"; AID="$cand"; break; fi
done < <(gh_api "repos/${REPO}/actions/workflows/${WF_ID}/runs?head_sha=${HEAD_SHA}&per_page=100" \
           --jq '.workflow_runs | sort_by(.created_at) | reverse | .[].id' || true)
if [ -z "$RUN_ID" ] || [ -z "$AID" ]; then
  echo "::error::no ${REVIEW_WORKFLOW} run for PR #${PR_NUM} head ${HEAD_SHA} carries a non-expired ${ART_NAME}. The review gate never ran on this commit, or its attestation expired. Re-run the review gate, then republish. Refusing to publish (fail closed)."
  exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if ! gh_download "repos/${REPO}/actions/artifacts/${AID}/zip" "${TMP}/att.zip"; then
  echo "::error::failed to download attestation artifact ${AID} (after retries). Refusing to publish (fail closed)."
  exit 1
fi
if ! unzip -o -q "${TMP}/att.zip" -d "${TMP}/x"; then
  echo "::error::failed to extract attestation artifact ${AID} (corrupt zip or no disk). Refusing to publish (fail closed)."
  exit 1
fi
ATT="$(find "${TMP}/x" -type f -name 'attestation.json' -print 2>/dev/null | head -n1)"
if [ -z "$ATT" ]; then
  echo "::error::attestation artifact ${AID} extracted but contains no attestation.json. Refusing to publish (fail closed)."
  exit 1
fi

# Crypto trust root: verify the cosign keyless signature over the attestation against an
# allowlisted OIDC identity. Enforced in live mode; the signature file travels in the
# artifact next to attestation.json. (Go-live: card A finalizes the identity regex + issuer.)
if [ "$VERIFY_MODE" = "enforce" ]; then
  SIG="$(find "${TMP}/x" -type f -name 'attestation.json.sig' -print 2>/dev/null | head -n1)"
  CRT="$(find "${TMP}/x" -type f -name 'attestation.json.pem' -print 2>/dev/null | head -n1)"
  if [ -z "$SIG" ] || [ -z "$CRT" ]; then
    echo "::error::attestation artifact is missing its cosign signature/cert (.sig/.pem) — cannot verify authenticity. Refusing to publish (fail closed)."
    exit 1
  fi
  if ! COSIGN_EXPERIMENTAL=1 cosign verify-blob \
        --certificate "$CRT" --signature "$SIG" \
        --certificate-identity-regexp "${COSIGN_IDENTITY_REGEXP:?COSIGN_IDENTITY_REGEXP required in enforce mode (card A gate config)}" \
        --certificate-oidc-issuer "${COSIGN_OIDC_ISSUER:?COSIGN_OIDC_ISSUER required in enforce mode (card A gate config)}" \
        "$ATT" 2>&1 | gh_redact; then
    echo "::error::cosign signature verification FAILED for the attestation — signature invalid or signer identity not permitted. Refusing to publish (fail closed)."
    exit 1
  fi
  echo "cosign signature verified for attestation.json (identity allowlisted)."
fi

echo "attestation ${ART_NAME} (artifact ${AID}, ${REVIEW_WORKFLOW} run ${RUN_ID}) fetched for release commit ${SHA} (PR #${PR_NUM}); recomputed CONTENT_ID ${CID}."
decide "$ATT" "$CID" "$ALLOWLIST" "$CONFIG_HASH"
