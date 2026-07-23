#!/usr/bin/env bash
# grace-publish-gate.sh — the ENFORCEMENT half of the grace gate (XLS-615).
#
# XLS-412 made a kept CRITICAL VISIBLE on a PR (the gate is advisory). It does not
# yet STOP a publish: publish.yml published "what main carries" and read the grace
# verdict NOWHERE. So a CRITICAL that landed (advisory gate, or a human PR-body
# override) would ship to npm anyway — and `npm publish` cannot be undone.
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
# FAILS CLOSED (refuse, exit 1) on: severity CRITICAL; severity UNKNOWN (the gate could
# not read its own finding — unread is not a clean bill of health); a missing / expired /
# unreadable receipt; no PR found for the commit; or a receipt whose schema we do not
# recognize. "An unrun gate is not a pass"; a gate whose correctness depends on artifact
# retention refuses rather than assumes. PROCEEDS (exit 0) on: severity NONE or HIGH —
# HIGH is the overridable tier, adjudicated at the merge gate; this card scopes the
# publish refusal to a kept CRITICAL.
#
# Modes:
#   (live, default) resolve GITHUB_SHA -> its PR head sha -> grace-receipt-<headsha>
#                   -> override-receipt.json, via the same gh-api artifact path
#                   grace-review.yml itself uses to carry a receipt forward.
#   --receipt-file <path>  read a local override-receipt.json and decide. Same decision
#                   logic, no network — this is the seam the register-before-land RED-arm
#                   witness drives (seed a kept-CRITICAL receipt -> must refuse; clean -> proceeds).
set -euo pipefail

# ---- decision: the ONE place a severity becomes a publish verdict -------------------
decide() {  # decide <path-to-override-receipt.json>
  local f="$1" schema sev
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
      echo "grace verdict severity=${sev} — no kept CRITICAL. Publish may proceed."
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

# ---- live mode: locate the receipt for the commit being published -------------------
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required in live mode}"
SHA="${GITHUB_SHA:?GITHUB_SHA is required in live mode}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

# main is protected: every release commit lands via a reviewed PR. Map the squash
# commit on main back to that PR and its head sha (the receipt is keyed by head sha).
HEAD_SHA="$(gh api "repos/${REPO}/commits/${SHA}/pulls" \
              --jq '[.[] | select(.merged_at != null)] | sort_by(.merged_at) | last | .head.sha // empty' \
            2>/dev/null || echo "")"
if [ -z "$HEAD_SHA" ]; then
  # fall back to any associated PR (e.g. tag on the PR head itself), still fail closed if none
  HEAD_SHA="$(gh api "repos/${REPO}/commits/${SHA}/pulls" --jq '.[0].head.sha // empty' 2>/dev/null || echo "")"
fi
if [ -z "$HEAD_SHA" ]; then
  echo "::error::no pull request found for commit ${SHA} — cannot locate its grace receipt."
  echo "Every release commit on protected main lands via a reviewed PR; a commit with no PR"
  echo "has no grace verdict this gate can read. Refusing to publish (fail closed)."
  exit 1
fi

PNAME="grace-receipt-${HEAD_SHA}"
AID="$(gh api "repos/${REPO}/actions/artifacts?name=${PNAME}&per_page=100" \
         --jq "[.artifacts[] | select(.expired == false) | select(.name == \"${PNAME}\")] | sort_by(.created_at) | last | .id // empty" \
       2>/dev/null || echo "")"
if [ -z "$AID" ]; then
  echo "::error::grace receipt ${PNAME} was not found or has expired (artifacts retain 90 days)."
  echo "Re-run the grace gate on the PR (add the 'grace-recheck' label) to mint a fresh receipt,"
  echo "then republish. A gate whose correctness depends on retention refuses rather than assumes."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh api "repos/${REPO}/actions/artifacts/${AID}/zip" > "${TMP}/receipt.zip"
unzip -o -q "${TMP}/receipt.zip" -d "${TMP}"
echo "grace receipt ${PNAME} (artifact ${AID}) fetched for release commit ${SHA} (PR head ${HEAD_SHA})."
decide "${TMP}/override-receipt.json"
