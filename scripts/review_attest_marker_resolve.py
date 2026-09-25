#!/usr/bin/env python3
"""review_attest_marker_resolve — resolve card A's signed attestation MARKER for the publish gate.

SysArch RULED (2026-09-24, Confirm #2): the review attestation is delivered as a signed COMMENT
MARKER, not a build-artifact triplet. Card A (XLS-1774) posts, on the reviewed PR, comment lines:

    review-attest-marker: {"blob_b64": "<base64 canonical §13.1 predicate>",
                           "bundle_b64": "<base64 cosign keyless sigstore bundle>"}

This tool is the F (XLS-1778) SIGNATURE-AUTHENTICITY + SELECTION step only — it does NOT make the
trust decision (that stays in publish-attestation-gate.sh `decide()`, the one predicate judge). It:
  1. collects every `review-attest-marker:` line on the merged PR (or a local --marker file),
  2. cosign verify-blob --bundle keyless-verifies each against the EXACT allowlisted identity +
     the GitHub OIDC issuer (no broad regexp — a wildcard identity is the fail-open guard),
  3. keeps only markers whose signature+cert verify AND whose decoded predicate's
     subject_content_id == the candidate CONTENT_ID for the published commit,
  4. picks the LATEST such marker (comment order == chronological; a later unsigned/tampered line
     can never override an earlier genuinely-signed one — the XLS-1554 fail-open fix),
  5. writes that predicate JSON to --out and prints the verified cert identity to stdout.

Fail-closed everywhere: a read failure, no marker, no valid signature, or no subject match is a
nonzero exit and NO predicate written — the caller then refuses to publish. cosign absence/error
is treated as "not verified" (never a skip-to-pass).

The verify helpers mirror card A's review_attest_verify (same cosign invocation) so the two sides
never drift on what counts as an authentic marker.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time

MARKER_PREFIX = "review-attest-marker:"
GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"


def _log(msg: str) -> None:
    sys.stderr.write(msg.rstrip("\n") + "\n")


def load_allowlist(path: str) -> tuple[list[str], str]:
    """(allowed identities, issuer) from A's JSON signer-allowlist. Empty list => fail-closed."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    ids = data.get("allowed_signer_identities") or []
    issuer = data.get("oidc_issuer") or GITHUB_OIDC_ISSUER
    if not isinstance(ids, list) or not ids:
        raise ValueError("signer allowlist is empty (fail-closed)")
    return ids, issuer


def _gh_api_with_retry(cmd: list[str], *, timeout: int | None = None, tries: int | None = None,
                       backoff: float | None = None) -> subprocess.CompletedProcess:
    """Run a `gh api` command with a per-attempt timeout and bounded retries — the same posture as
    the gate script's gh_api() wrapper (60s/attempt, 4 tries) and symmetric with the cosign call's
    timeout=120. A transient timeout or non-zero exit is retried with linear backoff; a persistent
    failure RAISES so the caller fail-closes (an unmeasured comment set is never a pass). Without
    this a hung/paginating gh call would block the publish runner indefinitely (no timeout).
    Timeout/tries/backoff default from env (GH_API_TIMEOUT/GH_API_TRIES/GH_API_RETRY_BACKOFF) for
    ops tuning and fast tests."""
    if timeout is None:
        timeout = int(os.environ.get("GH_API_TIMEOUT", "60"))
    if tries is None:
        tries = int(os.environ.get("GH_API_TRIES", "4"))
    if backoff is None:
        backoff = float(os.environ.get("GH_API_RETRY_BACKOFF", "2.0"))
    last = ""
    for attempt in range(1, tries + 1):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            last = f"timeout after {timeout}s"
        else:
            if r.returncode == 0:
                return r
            last = f"rc={r.returncode}: {r.stderr.strip()[:200]}"
        if attempt < tries:
            _log(f"gh api attempt {attempt}/{tries} failed ({last}); retrying")
            time.sleep(backoff * attempt)
    raise RuntimeError(f"gh api read failed after {tries} attempts ({last})")


def fetch_markers_from_pr(repo: str, pr: int) -> list[str]:
    """Every `review-attest-marker:` payload across the PR's issue comments, in comment order.
    A read failure raises (unmeasured != pass)."""
    r = _gh_api_with_retry(
        ["gh", "api", "--paginate", f"repos/{repo}/issues/{pr}/comments", "-q", ".[].body"],
    )
    out: list[str] = []
    for ln in r.stdout.splitlines():
        s = ln.strip()
        if s.startswith(MARKER_PREFIX):
            out.append(s[len(MARKER_PREFIX):].strip())
    return out


def markers_from_file(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as fh:
        body = fh.read()
    lines = [ln.strip()[len(MARKER_PREFIX):].strip()
             for ln in body.splitlines() if ln.strip().startswith(MARKER_PREFIX)]
    return lines or [body.strip()]  # a bare JSON marker file is also accepted


def cosign_verify_blob(blob_path: str, bundle_path: str, identity: str, issuer: str,
                       *, cosign: str = "cosign", ignore_tlog: bool = False) -> bool:
    """True iff cosign keyless verify-blob succeeds for the EXACT identity + issuer. Any cosign
    absence/error is False (fail-closed)."""
    cmd = [cosign, "verify-blob", "--bundle", bundle_path,
           "--certificate-identity", identity, "--certificate-oidc-issuer", issuer]
    if ignore_tlog:
        cmd.append("--insecure-ignore-tlog")  # degraded --no-tlog-upload path (sysarch-approved)
    cmd.append(blob_path)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        _log(f"cosign verify-blob unavailable/failed: {e}")
        return False
    if r.returncode != 0:
        _log(f"cosign verify-blob REJECTED for identity {identity!r}: {r.stderr.strip()[:200]}")
        return False
    return True


def select_marker(markers: list[str], allowlist: list[str], issuer: str, candidate_cid: str,
                  *, cosign: str, ignore_tlog: bool) -> tuple[dict, str] | tuple[None, None]:
    """Return (predicate, cert_identity) of the LATEST marker whose cosign signature verifies
    against an allowlisted identity AND whose subject_content_id == candidate_cid. (None, None)
    if none qualify (fail-closed)."""
    chosen: tuple[dict, str] | None = None
    for raw in markers:  # comment order == chronological; last qualifying wins
        try:
            m = json.loads(raw)
            blob = base64.b64decode(m["blob_b64"])
            bundle = base64.b64decode(m["bundle_b64"])
        except Exception as e:  # noqa: BLE001 — any malformed marker is skipped (fail-closed)
            _log(f"skipping malformed marker: {e}")
            continue
        with tempfile.TemporaryDirectory() as td:
            bp, bu = os.path.join(td, "blob.bin"), os.path.join(td, "bundle.json")
            with open(bp, "wb") as f:
                f.write(blob)
            with open(bu, "wb") as f:
                f.write(bundle)
            verified_identity = None
            for ident in allowlist:  # pinned EXACT identities, never a regexp
                if cosign_verify_blob(bp, bu, ident, issuer, cosign=cosign, ignore_tlog=ignore_tlog):
                    verified_identity = ident
                    break
            if verified_identity is None:
                continue
            try:
                predicate = json.loads(blob.decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                _log(f"marker signature valid but predicate unparsable: {e}")
                continue
            # bind to THIS content: only a marker attesting the published CONTENT_ID qualifies.
            if not isinstance(predicate, dict) or predicate.get("subject_content_id") != candidate_cid:
                continue
            chosen = (predicate, verified_identity)  # keep scanning; latest qualifying wins
    return chosen if chosen is not None else (None, None)


def main() -> int:
    ap = argparse.ArgumentParser(description="Resolve card A's signed attestation marker (F publish gate)")
    ap.add_argument("--repo", help="owner/repo (self-fetch PR comments) — omit with --marker")
    ap.add_argument("--pr", type=int, help="PR number to read markers from")
    ap.add_argument("--candidate-cid", required=True, help="the published content's CONTENT_ID")
    ap.add_argument("--allowlist", required=True, help=".github/review-gate/signer-allowlist.json (base ref)")
    ap.add_argument("--expect-issuer", default=None,
                    help="pinned OIDC issuer; if given, the allowlist's oidc_issuer MUST equal it "
                         "(fail-closed on mismatch) — defense-in-depth over A's allowlist JSON")
    ap.add_argument("--marker", default=None, help="local marker file (else self-fetch from the PR)")
    ap.add_argument("--out", required=True, help="write the selected authentic predicate JSON here")
    ap.add_argument("--cosign", default=os.environ.get("COSIGN_BIN", "cosign"))
    ap.add_argument("--ignore-tlog", action="store_true", help="degraded --no-tlog-upload verify path")
    args = ap.parse_args()

    if not args.candidate_cid:
        _log("RED: no candidate content_id (fail-closed).")
        return 2
    try:
        allowlist, issuer = load_allowlist(args.allowlist)
        # Pin the issuer (mirrors how the gate pins + cross-checks the signer identity): if F declares
        # an expected OIDC issuer, the allowlist's oidc_issuer must equal it, else fail-closed. For a
        # correctly-configured allowlist (GitHub OIDC) this is a no-op; it only rejects a tampered or
        # unexpected issuer, so the cosign invocation stays byte-identical to A's for valid config.
        if args.expect_issuer and issuer != args.expect_issuer:
            _log(f"RED: allowlist oidc_issuer {issuer!r} != pinned expected issuer "
                 f"{args.expect_issuer!r} — fail-closed.")
            return 3
        if args.marker:
            markers = markers_from_file(args.marker)
        else:
            if not args.repo or not args.pr:
                _log("RED: --repo and --pr required when no --marker file is given (fail-closed).")
                return 2
            markers = fetch_markers_from_pr(args.repo, args.pr)
        if not markers:
            _log("RED: no review-attest-marker on the PR (no attestation) — fail-closed.")
            return 3
        predicate, cert_identity = select_marker(
            markers, allowlist, issuer, args.candidate_cid,
            cosign=args.cosign, ignore_tlog=args.ignore_tlog,
        )
        if predicate is None:
            _log("RED: no marker carried a valid keyless signature from an allowlisted identity "
                 "for the published content_id — fail-closed.")
            return 3
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(predicate, fh)
        sys.stdout.write(cert_identity)  # the verified cert identity, for the gate's declared== check
        return 0
    except Exception as e:  # noqa: BLE001 — nothing unmeasured passes
        _log(f"RED (fail-closed): {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
