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

# ---- gh api with bounded retry/backoff ---------------------------------------------
# A transient network/API hiccup must not fail-closed a legitimate publish. Retry a few
# times with backoff; a persistent failure still fails closed (the caller refuses).
gh_api() {  # gh_api <api-path> [jq...] — echoes stdout, returns gh's rc on final attempt
  local attempt rc=1 out
  for attempt in 1 2 3 4; do
    if out="$(gh api "$@" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
    rc=$?
    [ "$attempt" -lt 4 ] && sleep $((attempt * 2))
  done
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
  case "$schema" in
    grace-override-receipt/*) : ;;
    *) echo "::error::unrecognized grace receipt schema '${schema}' — a receipt this gate cannot read is not a pass. Refusing to publish."
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
      jq -c '{schema,severity,criticals,highs,would_have_blocked,pr,diff_id}' "$f" 2>/dev/null || true
      exit 1 ;;
    UNKNOWN)
      echo "::error::grace verdict is UNKNOWN — the gate could not read its own CRITICAL section (unread is not clean). Refusing to publish."
      exit 1 ;;
    NONE|HIGH)
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
  decide "$2"
fi

# ---- live mode: locate the AUTHENTIC receipt for the commit being published ---------
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
  ([.[] | select(.merged_at != null)] | sort_by(.merged_at) | last) // .[0]
  | "\(.number // "") \(.head.sha // "")"')
if [ -z "${HEAD_SHA:-}" ] || [ -z "${PR_NUM:-}" ]; then
  echo "::error::no pull request found for commit ${SHA} — cannot locate its grace receipt."
  echo "Every release commit on protected main lands via a reviewed PR; a commit with no PR"
  echo "has no grace verdict this gate can read. Refusing to publish (fail closed)."
  exit 1
fi

# Bind to grace-review.yml's own workflow run for this head sha. Only the repo's review
# CI produces these; a forged same-named artifact from any other workflow is not here.
WF_ID="$(gh_api "repos/${REPO}/actions/workflows" \
           --jq ".workflows[] | select(.path == \"${WORKFLOW_PATH}\") | .id" | head -n1 || true)"
if [ -z "$WF_ID" ]; then
  echo "::error::grace-review workflow (${WORKFLOW_PATH}) not found in ${REPO}. Refusing to publish (fail closed)."
  exit 1
fi
RUN_ID="$(gh_api "repos/${REPO}/actions/workflows/${WF_ID}/runs?head_sha=${HEAD_SHA}&per_page=100" \
            --jq '[.workflow_runs[]] | sort_by(.created_at) | last | .id // empty' || true)"
if [ -z "$RUN_ID" ]; then
  echo "::error::no grace-review run found for PR #${PR_NUM} head ${HEAD_SHA}. The gate never ran"
  echo "on this commit, so there is no authentic verdict to read. Re-run grace-review (add the"
  echo "'grace-recheck' label) and republish. Refusing to publish (fail closed)."
  exit 1
fi
AID="$(gh_api "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" \
         --jq "[.artifacts[] | select(.name == \"grace-receipt-${HEAD_SHA}\") | select(.expired == false)] | sort_by(.created_at) | last | .id // empty" || true)"
if [ -z "$AID" ]; then
  echo "::error::grace receipt grace-receipt-${HEAD_SHA} not found (or expired) on grace-review run ${RUN_ID}."
  echo "Artifacts retain 90 days; re-run grace-review (label 'grace-recheck') to mint a fresh receipt,"
  echo "then republish. A gate whose correctness depends on retention refuses rather than assumes."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! gh_api "repos/${REPO}/actions/artifacts/${AID}/zip" > "${TMP}/receipt.zip"; then
  echo "::error::failed to download grace receipt artifact ${AID} (after retries). Refusing to publish (fail closed)."
  exit 1
fi
unzip -o -q "${TMP}/receipt.zip" -d "${TMP}"
echo "grace receipt grace-receipt-${HEAD_SHA} (artifact ${AID}, grace-review run ${RUN_ID}) fetched for release commit ${SHA} (PR #${PR_NUM})."
decide "${TMP}/override-receipt.json" "${PR_NUM}"
