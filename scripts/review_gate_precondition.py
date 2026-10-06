#!/usr/bin/env python3
"""review_gate_precondition — XLS-1796 D1: decide whether the gate-of-record concluded PASS at a
head SHA, from the check-runs listing for the required check NAME.

Producer-agnostic: binds to the check-run NAME (`Multi-LLM diff defect review`), never to the
workflow that emits it, so the grace-review -> §13.3-decider producer swap needs no edit here
(grace-review.yml emits the successor under the SAME name on purpose).

CORRECTED D1 selection rule (XLS-1796, folded post grace-xlsx review):
  Among check-runs of the given name, consider ONLY those that are SETTLED to a DEFINITIVE
  conclusion. IGNORE `skipped` / `neutral` and anything not `completed` (queued / in_progress /
  a null conclusion). Of the definitive runs, take the MOST-RECENT (by completed_at, tie-broken
  by started_at, then check-run id). PASS iff that run's conclusion == `success`. A definitive
  non-success (failure / timed_out / cancelled / action_required / startup_failure / stale), OR
  no definitive run at all (absent / every run skipped-or-neutral / still pending), => NOT-PASS
  (fail-closed: no marker).

Why definitive-only, and why non-success terminals still fail-close:
  The panel job (event != 'edited') and the override-guard job (event == 'edited') are BOTH
  emitted under this same name and are mutually exclusive per event, so a `skipped` run routinely
  co-exists with the real one. A stray later skip-both event (e.g. 'labeled') must NOT knock out an
  earlier genuine pass, and a genuine edited->guard `failure` MUST supersede an earlier pass (it is
  the latest definitive). Selecting the latest DEFINITIVE run does both. Excluding ONLY
  skipped/neutral/pending — while treating every other terminal conclusion as a definitive fail —
  keeps this decision in agreement with how branch protection dispositions the same required check
  on the same head (acceptance §5.7): GitHub passes skipped/neutral through and blocks on
  failure/timed_out/cancelled/etc.

Pure: no network. The workflow does the (retry-wrapped) `gh api commits/{sha}/check-runs` fetch and
pipes the JSON here; the selftest drives the same evaluator with fixtures.

Input: the `GET /repos/{repo}/commits/{sha}/check-runs` response object (with a `check_runs` array)
or a bare array, from --check-runs-file (default: stdin).

exit 0 => PASS (mint).  exit 1 => NOT-PASS (fail-closed, no mint).  exit 2 => usage/parse error.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

# Sort-earliest sentinel for a missing/unparseable timestamp (aware, so it always compares against
# real aware stamps without a naive-vs-aware TypeError).
_TS_MIN = datetime(1, 1, 1, tzinfo=timezone.utc)


def _parse_ts(value: object) -> datetime:
    """Parse a GitHub ISO-8601 timestamp to an aware datetime for true chronological ordering.
    Normalizes a trailing 'Z' to '+00:00' (datetime.fromisoformat only accepts 'Z' on py3.11+), so
    ordering is by the actual instant rather than a lexicographic string compare that could misorder
    mixed UTC-offset/format variants. Missing or unparseable => _TS_MIN (sorts earliest)."""
    if not isinstance(value, str) or not value:
        return _TS_MIN
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return _TS_MIN
    # Treat a naive stamp as UTC so all keys are aware and mutually comparable.
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)

# Conclusions that do NOT count toward the definitive decision — a run in one of these states is
# skipped over entirely (it neither passes nor blocks), mirroring branch protection.
IGNORED_CONCLUSIONS = frozenset({"skipped", "neutral"})


def _is_definitive(run: dict) -> bool:
    """A run is definitive iff it has completed to a conclusion that is not skipped/neutral.

    Non-completed runs (queued / in_progress / a null conclusion) are not settled and are ignored.
    """
    if run.get("status") != "completed":
        return False
    conclusion = run.get("conclusion")
    if not isinstance(conclusion, str) or conclusion == "":
        return False
    return conclusion not in IGNORED_CONCLUSIONS


def _recency_key(run: dict) -> tuple:
    """Most-recent ordering: completed_at, then started_at, then id — timestamps parsed to aware
    datetimes (grace-xlsx LOW) so a non-'Z'/offset variant cannot lexicographically misorder the
    'latest definitive' selection and flip the pass decision. Missing/unparseable stamps sort
    earliest (_TS_MIN). id is coerced to str so the tiebreak stays a total order even under mixed
    int/str ids (they can't compare in py3); it only breaks exact-timestamp ties."""
    return (
        _parse_ts(run.get("completed_at")),
        _parse_ts(run.get("started_at")),
        str(run.get("id") if run.get("id") is not None else ""),
    )


def evaluate(check_runs: list[dict], check_name: str) -> tuple[bool, str]:
    """Return (is_pass, reason). is_pass True => mint; False => fail-closed (no marker)."""
    named = [r for r in check_runs if isinstance(r, dict) and r.get("name") == check_name]
    if not named:
        return False, f"no check-run named {check_name!r} at head — fail-closed (no gate ran)"

    definitive = [r for r in named if _is_definitive(r)]
    if not definitive:
        # Every run of this name is skipped/neutral/pending — the gate has not settled to a
        # definitive conclusion at this head. Absence of a definitive pass is the fail-closed signal.
        states = sorted({f"{r.get('status')}/{r.get('conclusion')}" for r in named})
        return False, (
            f"{len(named)} check-run(s) named {check_name!r} but NONE definitive "
            f"(states: {', '.join(states)}) — fail-closed"
        )

    latest = max(definitive, key=_recency_key)
    conclusion = latest.get("conclusion")
    if conclusion == "success":
        return True, (
            f"most-recent definitive {check_name!r} run "
            f"(id={latest.get('id')}, completed_at={latest.get('completed_at')}) == success — mint"
        )
    return False, (
        f"most-recent definitive {check_name!r} run "
        f"(id={latest.get('id')}, completed_at={latest.get('completed_at')}) == {conclusion!r} "
        f"(not success) — fail-closed"
    )


def _extract_runs(doc: object) -> list[dict]:
    """Accept either the API response object ({check_runs: [...]}) or a bare list of runs."""
    if isinstance(doc, dict):
        runs = doc.get("check_runs", [])
    elif isinstance(doc, list):
        runs = doc
    else:
        raise ValueError("check-runs input is neither an object with check_runs nor an array")
    if not isinstance(runs, list):
        raise ValueError("check_runs is not an array")
    return runs


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="XLS-1796 D1: mint-precondition — is the gate-of-record definitively green at head?"
    )
    ap.add_argument(
        "--check-name",
        default="Multi-LLM diff defect review",
        help="the required check-run name to bind to (producer-agnostic; default: the gate-of-record)",
    )
    ap.add_argument(
        "--check-runs-file",
        help="path to the GET commits/{sha}/check-runs JSON (default: read stdin)",
    )
    args = ap.parse_args(argv)

    try:
        raw = open(args.check_runs_file).read() if args.check_runs_file else sys.stdin.read()
        runs = _extract_runs(json.loads(raw))
    except (OSError, ValueError, json.JSONDecodeError) as e:
        sys.stderr.write(f"review_gate_precondition: cannot read check-runs input: {e}\n")
        return 2

    is_pass, reason = evaluate(runs, args.check_name)
    # stdout carries the machine-readable verdict; stderr the human reason (workflow log).
    print("pass" if is_pass else "not-pass")
    sys.stderr.write(f"review_gate_precondition: {reason}\n")
    return 0 if is_pass else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
