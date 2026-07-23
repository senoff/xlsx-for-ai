#!/usr/bin/env bash
# grace-publish-gate.sh — the ENFORCEMENT half of the grace gate (XLS-615).
#
# XLS-412 made a kept CRITICAL VISIBLE on a PR (the gate is advisory). It does not
# yet STOP a publish: publish.yml published "what main carries" and read the grace
# verdict NOWHERE. So a CRITICAL that landed (advisory gate, or a human PR-body
# override) would ship to npm, and `npm publish` cannot be undone.
#
# This gate reads the grace verdict from the MACHINE CONTRACT and refuses to publish
# when a CRITICAL was kept. The verdict is `override-receipt.json`'s `severity` field
# (schema grace-override-receipt/2) — NOT a grep of rendered markdown. That is the same
# root-cause family as XLS-412/426: the prose is owned by its author, the verdict is the
# contract. severity is refute-aware (/2): a downgraded/refuted critical is not counted,
# so `severity == CRITICAL` IS a *kept* CRITICAL. CRITICAL is non-overridable — a
# PR-body `grace-override:` does not clear it (grace-override-guard codes CRITICAL as
# never-overridable), which is exactly why enforcement belongs here, at the irreversible
# boundary, and not only at the advisory merge gate.
#
# THE RECEIPT MUST BE AUTHENTIC, NOT MERELY NAMED. Selecting the receipt artifact by
# name repo-wide is spoofable: any workflow run can upload a same-named
# `grace-receipt-<headsha>` with severity=NONE and forge a clean verdict — the very
# forgeable-verdict bypass class XLS-412 removed from the 476-line carry-forward. So the
# receipt is bound to a run OF THE grace-review.yml WORKFLOW for the PR head sha (only
# the repo's own review CI produces those), and the receipt's own `pr` field is checked
# against the PR we resolved. A same-named artifact uploaded by any other workflow is
# not in grace-review.yml's run and is never consulted.
#
# FAILS CLOSED (refuse, exit 1) on: severity CRITICAL; severity UNKNOWN (the gate could
# not read its own finding — unread is not a clean bill of health); a missing / expired /
# unreadable receipt; no PR for the commit; no grace-review run for the head sha; a
# receipt whose schema we do not recognize or whose `pr` does not match. "An unrun gate
# is not a pass"; a gate whose correctness depends on artifact retention refuses rather
# than assumes. PROCEEDS (exit 0) on: severity NONE or HIGH — HIGH is the overridable
# tier, adjudicated at the merge gate; this card scopes the publish refusal to a kept
# CRITICAL.
#
# Modes:
#   (live, default) resolve GITHUB_SHA -> its PR (head sha + number) -> the grace-review
#                   WORKFLOW RUN for that head sha -> that run's grace-receipt-<headsha>
#                   artifact -> override-receipt.json.
#   --receipt-file <path>  read a local override-receipt.json and decide. Same decision
#                   logic, no network — the seam the register-before-land RED-arm witness
#                   drives (seed a kept-CRITICAL receipt -> must refuse; clean -> proceeds).
set -euo pipefail

WORKFLOW_PATH=".github/workflows/grace-review.yml"

# ---- required CLIs — fail with an actionable error, not an opaque one ---------------
need() { command -v "$1" >/dev/null 2>&1 || { echo "::error::required tool '$1' not found on the runner. Refusing to publish (fail closed)."; exit 1; }; }

# ---- redact token-shaped strings from any diagnostic before it hits the log ---------
# A persistent failure must be diagnosable (403 vs 404 vs 5xx) WITHOUT dumping raw tool
# stderr — which can echo request URLs/bodies — onto a PUBLIC Actions log. gh does not
# print the auth token to stderr, but mask token-shaped strings as defence in depth so
# the summary is "not silent, not raw": the terminal resolution of the show-vs-hide split.
gh_redact() {  # stdin -> stdout, GitHub/Bearer token patterns masked
  sed -E 's/(gh[posru]_|github_pat_)[A-Za-z0-9_]+/\1***REDACTED***/g; s/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1***REDACTED***/g'
}

# ---- gh api with bounded retry/backoff + a per-call timeout -------------------------
# A transient network/API hiccup must not fail-closed a legitimate publish. Retry a few
# times with backoff; a persistent failure still fails closed (the caller refuses). Every
# call is `timeout`-bounded so a hung call cannot stall the publish.
gh_api() {  # gh_api <api-path> [gh-flags...] — STREAMS gh's stdout, returns gh's rc
  # STREAM the output — do NOT capture into a var and re-printf. A shell variable
  # truncates at the first NUL, which corrupts any binary body (the receipt zip). JSON
  # bodies have no NULs, so JSON callers ($(gh_api ...)) are unaffected; binary bodies go
  # through gh_download (below), never here. gh writes its response body only on success,
  # so a failed attempt contributes no partial stdout to concatenate.
  # Every call is GUARANTEED-bounded by `timeout 60` — live mode requires `timeout`
  # (need timeout, below), so a hung gh api call is killed and retried rather than
  # stalling the publish job indefinitely. An unbounded network call is the one thing an
  # enforcement gate on an irreversible publish must not do.
  # stderr is captured to a temp file on EVERY attempt and, only on a persistent failure,
  # surfaced as a REDACTED bounded tail — diagnosable but never raw on a public log.
  # NOTE the `cmd && { ...; }` form, not `if cmd; then ...; fi` followed by rc=$?: an
  # if-statement whose condition fails and which has no else-branch exits 0, so `rc=$?`
  # after `fi` would capture 0 (success) on a real failure. `&&` short-circuits so $? is
  # the command's true exit — the function must return non-zero when gh actually failed.
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
  # For a BINARY body (the receipt zip): write each attempt to a FRESH temp file
  # (truncating), and move it into place ONLY on a fully-successful download. This keeps
  # the bytes intact (no shell-var round-trip) AND guarantees a partial body from a failed
  # attempt is never concatenated with a later one. Bounded by `timeout` like gh_api; same
  # captured-then-redacted stderr discipline on a persistent failure.
  # `cmd && { ...; }` (not `if cmd; then ...; fi` + rc=$?) so rc is gh's true exit — see
  # the note in gh_api. `if ! gh_download` in the caller depends on a non-zero on failure.
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

# ---- decision: the ONE place a severity becomes a publish verdict -------------------
decide() {  # decide <path-to-override-receipt.json> [expected-pr-number]
  local f="$1" want_pr="${2:-}" schema sev rpr
  if [ ! -s "$f" ]; then
    echo "::error::grace receipt missing or empty ($f) — cannot certify the absence of a CRITICAL. Refusing to publish."
    exit 1
  fi
  schema="$(jq -r '.schema // ""' "$f" 2>/dev/null || echo "")"
  # Pin to the EXACT schema this gate implements. /2's `severity` is refute-aware (a
  # proven-false CRITICAL is dropped) — the whole basis for reading `.severity` as the
  # kept-verdict. A /1 receipt is NOT refute-aware: its `severity=CRITICAL` may be a
  # refuted critical → a false publish refusal. A /3+ may redefine the contract this gate
  # reads. So accept ONLY /2 and fail closed on anything else: an enforcement gate on an
  # irreversible publish must not read a receipt contract it does not implement. When
  # grace bumps the schema, revisit this gate (fail-closed until then is the safe default).
  case "$schema" in
    grace-override-receipt/2) : ;;
    *) echo "::error::grace receipt schema '${schema}' is not grace-override-receipt/2 (the refute-aware version this gate implements) — refusing to publish (fail closed). Update grace-publish-gate.sh for the new receipt contract."
       exit 1 ;;
  esac
  # Internal binding: the receipt must name the PR we resolved (defence in depth on top
  # of the workflow-run binding). Skipped in --receipt-file test mode (no PR to match).
  if [ -n "$want_pr" ]; then
    rpr="$(jq -r '.pr // ""' "$f" 2>/dev/null || echo "")"
    if [ "$rpr" != "$want_pr" ]; then
      echo "::error::grace receipt names PR '${rpr}' but this commit resolved to PR '${want_pr}' — the receipt does not answer for this release. Refusing to publish."
      exit 1
    fi
  fi
  sev="$(jq -r '.severity // "UNKNOWN"' "$f" 2>/dev/null || echo "UNKNOWN")"
  case "$sev" in
    CRITICAL)
      echo "::error::grace KEPT a CRITICAL (receipt severity=CRITICAL, non-overridable) — refusing to publish."
      # Emit COUNTS only. criticals/highs/would_have_blocked are integer tallies and
      # schema grace-override-receipt/2 carries no finding text, snippets, or code
      # fragments — so this cannot leak secrets/PII into the (public) Actions log. Print
      # as explicit scalar key=value pairs, never the raw JSON object, to keep that plain.
      echo "  receipt: schema=$(jq -r '.schema // "?"' "$f" 2>/dev/null) severity=$(jq -r '.severity // "?"' "$f" 2>/dev/null) criticals=$(jq -r '.criticals // "?"' "$f" 2>/dev/null) highs=$(jq -r '.highs // "?"' "$f" 2>/dev/null) would_have_blocked=$(jq -r '.would_have_blocked // "?"' "$f" 2>/dev/null) pr=$(jq -r '.pr // "?"' "$f" 2>/dev/null)"
      exit 1 ;;
    UNKNOWN)
      echo "::error::grace verdict is UNKNOWN — the gate could not read its own CRITICAL section (unread is not clean). Refusing to publish."
      exit 1 ;;
    NONE|LOW|MEDIUM|HIGH)
      # This card scopes the publish refusal to a KEPT CRITICAL. Everything below CRITICAL
      # is adjudicated at the merge gate (HIGH is the overridable tier). NONE/LOW/MEDIUM
      # are listed explicitly so a minor receipt-schema revision that emits a sub-CRITICAL
      # tier proceeds rather than tripping the fail-closed `*)` on a non-blocking severity.
      echo "grace verdict severity=${sev} (receipt PR ${rpr:-n/a}) — no kept CRITICAL. Publish may proceed."
      exit 0 ;;
    *)
      echo "::error::unexpected grace severity '${sev}' — refusing to publish (fail closed)."
      exit 1 ;;
  esac
}

# ---- arg parse ----------------------------------------------------------------------
if [ "${1:-}" = "--receipt-file" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --receipt-file <override-receipt.json>" >&2; exit 2; }
  need jq
  decide "$2"
fi

# ---- live mode: locate the AUTHENTIC receipt for the commit being published ---------
# `timeout` is REQUIRED, not best-effort: it is the guaranteed bound on every gh api
# call (see gh_api). A runner without it fails closed here with an actionable message
# rather than risking an indefinite hang mid-publish.
need gh; need jq; need unzip; need timeout
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required in live mode}"
SHA="${GITHUB_SHA:?GITHUB_SHA is required in live mode}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

# main is protected: every release commit lands via a reviewed PR. Map the squash commit
# on main back to that PR — its number (for the receipt's internal binding) and its head
# sha (the receipt is keyed by head sha).
PR_JSON="$(gh_api "repos/${REPO}/commits/${SHA}/pulls" || true)"
if [ -z "$PR_JSON" ]; then
  echo "::error::could not query pull requests for commit ${SHA} (after retries). Refusing to publish (fail closed)."
  exit 1
fi
read -r PR_NUM HEAD_SHA < <(printf '%s' "$PR_JSON" | jq -r '
  ((([.[] | select(.merged_at != null)] | sort_by(.merged_at) | last) // .[0]) // {})
  | "\(.number // "") \(.head.sha // "")"')
if [ -z "${HEAD_SHA:-}" ] || [ -z "${PR_NUM:-}" ]; then
  echo "::error::no pull request found for commit ${SHA} — cannot locate its grace receipt."
  echo "Every release commit on protected main lands via a reviewed PR; a commit with no PR"
  echo "has no grace verdict this gate can read. Refusing to publish (fail closed)."
  exit 1
fi

# Bind to grace-review.yml's own workflow run for this head sha. Only the repo's review
# CI produces these; a forged same-named artifact from any other workflow is not here.
# Look the workflow up DIRECTLY by filename (the API accepts the basename as the id):
# listing /actions/workflows is paginated at 30, so a repo with >30 workflows could omit
# grace-review.yml and yield a false "not found" that fails a legitimate publish closed.
WF_JSON="$(gh_api "repos/${REPO}/actions/workflows/$(basename "$WORKFLOW_PATH")" || true)"
WF_ID="$(printf '%s' "$WF_JSON" | jq -r '.id // empty' 2>/dev/null || echo "")"
if [ -z "$WF_ID" ]; then
  echo "::error::grace-review workflow ($(basename "$WORKFLOW_PATH")) not found in ${REPO}. Refusing to publish (fail closed)."
  exit 1
fi

# A head sha can have several grace-review runs (a rerun, a canceled attempt, an earlier
# green). The NEWEST run is not necessarily the one carrying the receipt — a canceled or
# failed rerun would have none. Walk the runs newest->oldest and take the first that
# actually holds a non-expired grace-receipt-<headsha>; refuse only if NONE do. This
# stops a later runless attempt from masking an earlier valid receipt (false fail-closed).
RUN_ID=""; AID=""
while IFS= read -r rid; do
  [ -n "$rid" ] || continue
  cand="$(gh_api "repos/${REPO}/actions/runs/${rid}/artifacts?per_page=100" \
            --jq "[.artifacts[] | select(.name == \"grace-receipt-${HEAD_SHA}\") | select(.expired == false)] | sort_by(.created_at) | last | .id // empty" || true)"
  if [ -n "$cand" ]; then RUN_ID="$rid"; AID="$cand"; break; fi
done < <(gh_api "repos/${REPO}/actions/workflows/${WF_ID}/runs?head_sha=${HEAD_SHA}&per_page=100" \
           --jq '.workflow_runs | sort_by(.created_at) | reverse | .[].id' || true)
if [ -z "$RUN_ID" ] || [ -z "$AID" ]; then
  echo "::error::no grace-review run for PR #${PR_NUM} head ${HEAD_SHA} carries a non-expired grace-receipt-${HEAD_SHA}."
  echo "The gate never ran on this commit, or its receipt expired (90d retention). Re-run grace-review"
  echo "(add the 'grace-recheck' label) to mint a fresh receipt, then republish. Refusing to publish (fail closed)."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! gh_download "repos/${REPO}/actions/artifacts/${AID}/zip" "${TMP}/receipt.zip"; then
  echo "::error::failed to download grace receipt artifact ${AID} (after retries). Refusing to publish (fail closed)."
  exit 1
fi
if ! unzip -o -q "${TMP}/receipt.zip" -d "${TMP}/x"; then
  echo "::error::failed to extract grace receipt artifact ${AID} (corrupt zip or no disk). Refusing to publish (fail closed)."
  exit 1
fi
# Do NOT assume override-receipt.json sits at the zip root: an artifact zip can nest its
# files under a top-level folder (often the artifact name). Locate it by search — a valid
# receipt one directory down must not read as "missing" and fail a legitimate publish.
RECEIPT="$(find "${TMP}/x" -type f -name 'override-receipt.json' -print 2>/dev/null | head -n1)"
if [ -z "$RECEIPT" ]; then
  echo "::error::grace receipt artifact ${AID} extracted but contains no override-receipt.json. Refusing to publish (fail closed)."
  exit 1
fi
echo "grace receipt grace-receipt-${HEAD_SHA} (artifact ${AID}, grace-review run ${RUN_ID}) fetched for release commit ${SHA} (PR #${PR_NUM})."
decide "$RECEIPT" "${PR_NUM}"
