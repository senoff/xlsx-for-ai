#!/usr/bin/env bash
# publish-path-detach-guard.sh — assert the grace gate is DETACHED from the npm PUBLISH PATH
# (XLS-1778, gate cutover card F; §14.F "no grace reference remains in the publish path —
# the detach-guard passes on it").
#
# The publish PATH is the workflow that authorizes-and-performs the irreversible npm publish
# (publish.yml) plus the scripts it invokes (the new attestation gate + the content-id recipe).
# "Detached" means two distinct things, checked separately:
#
#   1. publish.yml — the publish workflow itself — carries NO grace reference AT ALL. Post-F it
#      does not invoke grace tooling, does not read a grace receipt, and does not even mention
#      grace in a comment. A single `grace` substring here fails the guard (strict).
#
#   2. the new gate scripts (publish-attestation-gate.sh, content_id.py) must not DEPEND ON grace
#      — i.e. must not INVOKE grace tooling or read a grace artifact. They MAY still name grace,
#      because their defined job is to RECOGNISE-AND-REFUSE a grace-style receipt (the RFC
#      anti-carryover rule) and to document that this recipe was de-graced from XLS-1554. So this
#      tier forbids only grace-DEPENDENCY patterns (calling a grace script / reading a grace
#      workflow or receipt), never the mere word.
#
# grace-review.yml (the review CI workflow) is NOT in scope — it legitimately remains in the repo
# until the separate switch-on/delete card. This guard is about the PUBLISH path only.
#
# --selftest proves both tiers still redden (a detector that cannot fail is not a detector).
#
# Exit: 0 = detached (pass) · 1 = a grace attachment remains (fail) · 2 = usage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"

WORKFLOW="\.github/workflows/publish.yml"      # tier 1: must be 100% grace-free
GATE_SCRIPTS=("scripts/publish-attestation-gate.sh" "scripts/content_id.py")  # tier 2: no grace dependency

# grace-DEPENDENCY patterns: invoking a grace script, or reading a grace workflow/receipt/marker.
# NOT the bare word — a comment or refusal-logic mention of grace is allowed in the new gate.
DEP_RE='grace-publish-gate|grace-review\.yml|grace-gate\.yml|\.grace/|grace_cosign|grace-cosign|grace_gate|grace_content_id|grace-content-id|grace_marker|grace-clear|bash[^\n]*grace|override-receipt\.json'

# tier 1: any grace substring in the publish workflow -> hits printed, rc 1 if any.
scan_workflow() {  # scan_workflow <root> -> prints "file:line:match"; rc 1 if any hit
  local root="$1" tf; tf="$(mktemp)"
  local rc=0
  if grep -niE 'grace' "${root}/.github/workflows/publish.yml" >"$tf" 2>/dev/null; then
    sed 's#^#.github/workflows/publish.yml:#' "$tf"; rc=1
  fi
  rm -f "$tf"; return "$rc"
}

# tier 2: any grace-DEPENDENCY pattern in a gate script -> hits printed, rc 1 if any.
scan_scripts() {  # scan_scripts <root> <file...> -> prints "file:line:match"; rc 1 if any hit
  local root="$1"; shift
  local rc=0 f tf; tf="$(mktemp)"
  for f in "$@"; do
    [ -f "${root}/${f}" ] || continue
    if grep -niE "$DEP_RE" "${root}/${f}" >"$tf" 2>/dev/null; then
      sed "s#^#${f}:#" "$tf"; rc=1
    fi
  done
  rm -f "$tf"; return "$rc"
}

if [ "${1:-}" = "--selftest" ]; then
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
  mkdir -p "${t}/.github/workflows" "${t}/scripts"
  # tier 1 greens on a clean workflow, reddens on a planted grace mention.
  printf 'run: bash scripts/publish-attestation-gate.sh\n' > "${t}/.github/workflows/publish.yml"
  scan_workflow "$t" >/dev/null && ok1=green || ok1=red
  [ "$ok1" = green ] || { echo "  selftest FAIL: tier1 flagged a clean workflow"; exit 1; }
  printf 'run: bash scripts/grace-publish-gate.sh\n' > "${t}/.github/workflows/publish.yml"
  scan_workflow "$t" >/dev/null && ok1b=green || ok1b=red
  [ "$ok1b" = red ] || { echo "  selftest FAIL: tier1 missed a grace mention in the workflow"; exit 1; }
  # tier 2 greens on refusal-logic that only NAMES grace, reddens on an actual grace invocation.
  printf 'if schema ~ grace-override-receipt: refuse   # names grace to reject it\n' > "${t}/scripts/content_id.py"
  scan_scripts "$t" "scripts/content_id.py" >/dev/null && ok2=green || ok2=red
  [ "$ok2" = green ] || { echo "  selftest FAIL: tier2 flagged a refusal-only grace mention"; exit 1; }
  printf 'bash scripts/grace-publish-gate.sh   # a real dependency\n' > "${t}/scripts/content_id.py"
  scan_scripts "$t" "scripts/content_id.py" >/dev/null && ok2b=green || ok2b=red
  [ "$ok2b" = red ] || { echo "  selftest FAIL: tier2 missed a real grace invocation"; exit 1; }
  echo "  selftest PASS: tier1 (workflow grace-free) and tier2 (scripts grace-dependency-free) both redden on a real attachment."
  exit 0
fi

if [ $# -ne 0 ]; then
  echo "usage: $0 [--selftest]   (scans the publish path for a grace attachment)" >&2
  exit 2
fi

fail=0
if hits="$(scan_workflow "$REPO_ROOT")"; then :; else
  echo "::error::detach-guard FAILED (tier 1) — the publish workflow still references grace:" >&2
  printf '%s\n' "$hits" >&2
  fail=1
fi
if shits="$(scan_scripts "$REPO_ROOT" "${GATE_SCRIPTS[@]}")"; then :; else
  echo "::error::detach-guard FAILED (tier 2) — a gate script still DEPENDS ON grace (invokes grace tooling / reads a grace artifact):" >&2
  printf '%s\n' "$shits" >&2
  fail=1
fi
if [ "$fail" -eq 0 ]; then
  echo "detach-guard PASS: publish.yml is grace-free and the gate scripts carry no grace dependency."
  exit 0
fi
echo "Detach these before the new publish gate is switched on (§14.F: no grace reference in the publish path)." >&2
exit 1
