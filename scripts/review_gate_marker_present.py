#!/usr/bin/env python3
"""review_gate_marker_present — XLS-1796 D1 idempotency guard.

Given the PR's issue-comment bodies, decide whether a `review-attest-marker:` for a specific
content_id ALREADY carries. `sign` uses this before posting so a D2 re-trigger or a workflow re-run
for one head does not post a duplicate marker (acceptance §5.5). Pure: no network — the workflow
supplies the comment bodies (retry-wrapped `gh api …/comments --jq .[].body`); the selftest supplies
fixtures.

Marker wire-format (unchanged, RFC §13.1): a line `review-attest-marker: {json}` whose JSON has a
base64 `blob_b64` of the canonical predicate; the predicate's `subject_content_id` is the head
binding. We match on that content_id, NOT on the raw blob bytes — the predicate carries a per-run
`timestamp`, so two mints for one head produce different blobs but the SAME content_id.

exit 0 => a marker for --content-id is present (caller no-ops).
exit 1 => not present (caller posts).  exit 2 => usage/read error.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys

MARKER_PREFIX = "review-attest-marker:"


def _candidate_lines(text: str):
    """Yield each physical line, AND — for any line carrying JSON escapes — its unescaped form.

    Defense-in-depth against a JSON-ESCAPED comment body (a producer that hands back
    `gh api --jq .body` output instead of raw text): the whole body collapses onto one physical
    line with literal `\\n` / `\\"`, hiding the marker line's newline and quotes from a line finder.
    A JSON-escaped body has no bare `"`, so wrapping it as a JSON string and decoding recovers the
    real newlines/quotes; on any failure we simply skip the extra candidate (never fatal). The
    workflow already forces RAW output — this keeps the check correct even if a caller does not."""
    for line in text.splitlines():
        yield line
        if "\\" not in line:
            continue
        # Try both escaped shapes: a bare escaped fragment (`...\n...`) wrapped as a JSON string, and
        # a full JSON string literal (`"...\n..."`) decoded directly. Either recovers real newlines.
        for candidate in ('"' + line + '"', line):
            try:
                unescaped = json.loads(candidate)
            except Exception:
                continue
            if isinstance(unescaped, str) and unescaped != line:
                yield from unescaped.splitlines()
                break


def content_ids_in(text: str) -> list[str]:
    """Every subject_content_id decodable from the marker lines in `text` (best-effort: a malformed
    marker is skipped, never fatal — a bad marker must not wedge the idempotency check)."""
    found: list[str] = []
    decoder = json.JSONDecoder()
    for line in _candidate_lines(text):
        idx = line.find(MARKER_PREFIX)
        if idx == -1:
            continue
        raw = line[idx + len(MARKER_PREFIX):].strip()
        try:
            # raw_decode parses the FIRST JSON object and ignores any trailing content on the line, so
            # a marker that is not the last thing on its physical line is still read.
            marker, _ = decoder.raw_decode(raw)
            # STRUCTURAL VALIDITY (grace-xlsx HIGH): a marker only counts as "present" (and so
            # suppresses a fresh mint) if it is minimally well-formed — BOTH blob_b64 and bundle_b64
            # are non-empty strings that base64-decode (validate=True, rejecting stray non-base64
            # bytes) AND the blob parses as a JSON predicate carrying a subject_content_id. Without
            # this a crafted/garbage `review-attest-marker:` line with a matching content_id but no
            # valid signature bundle would wedge the idempotency check into skipping a REAL marker,
            # leaving verify RED. `review-attestation-verify` still independently checks the
            # signature — this guard only governs whether we treat a line as an existing marker.
            blob_b64 = marker.get("blob_b64")
            bundle_b64 = marker.get("bundle_b64")
            if not (isinstance(blob_b64, str) and blob_b64 and isinstance(bundle_b64, str) and bundle_b64):
                continue
            base64.b64decode(bundle_b64, validate=True)  # bundle must be real base64 (not consumed here)
            blob = base64.b64decode(blob_b64, validate=True)
            predicate = json.loads(blob.decode("utf-8"))
            cid = predicate.get("subject_content_id")
        except Exception:
            # NEVER fatal: a malformed/garbage marker line (bad JSON, bad base64, wrong shape) must be
            # skipped, not crash the idempotency check — a broken marker must not wedge minting.
            continue
        if isinstance(cid, str) and cid:
            found.append(cid)
    return found


def is_present(text: str, content_id: str) -> bool:
    """Body-only presence check. TRUST IS THE CALLER'S RESPONSIBILITY (grace-xlsx HIGH, forged-marker
    DoS): `content_ids_in`/`is_present` look only at comment BODIES, so a marker in ANY comment —
    including one forged by an untrusted PR commenter who copies the current content_id — counts as
    present and would suppress the real mint. Callers MUST pre-filter the bodies to the TRUSTED
    signer identity before using this (the workflow fetches author-tagged comments and passes only
    the trusted author's), or use `content_ids_in_authored`, which enforces the trust boundary in
    this file and is what the selftest exercises."""
    return content_id in content_ids_in(text)


def content_ids_in_authored(comments: list[dict], trusted_author: str) -> list[str]:
    """Author-aware presence (the forged-marker-DoS fence). `comments` is a list of {author, body};
    ONLY bodies authored by `trusted_author` are scanned for markers — a marker forged by any other
    (untrusted) commenter is ignored and so cannot suppress a real mint. FAIL CLOSED: if
    `trusted_author` is falsy/empty (the workflow could not resolve the signer identity), NOTHING is
    trusted => returns [] => the caller treats the marker as absent and posts the real one (a
    duplicate at worst, never a suppressed real marker). A comment missing author/body, or whose
    author is not exactly the trusted login, is skipped."""
    if not trusted_author:
        return []
    found: list[str] = []
    for c in comments:
        if not isinstance(c, dict):
            continue
        if c.get("author") != trusted_author:
            continue
        body = c.get("body")
        if isinstance(body, str) and body:
            found.extend(content_ids_in(body))
    return found


def _read_ndjson_comments(text: str) -> list[dict]:
    """Parse author-tagged comments as NDJSON — one compact `{"author":…,"body":…}` object per line
    (the pagination- and escape-safe transport the workflow emits via `gh api --paginate --jq`). A
    malformed line is skipped, never fatal."""
    out: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="XLS-1796: is a marker for this content_id already posted?")
    ap.add_argument("--content-id", required=True, help="subject_content_id to look for")
    ap.add_argument("--comments-file", help="file of PR comment bodies (BODY-ONLY; caller must pre-filter to the trusted author). Default: stdin")
    ap.add_argument("--comments-ndjson", help="file of author-tagged comments, one JSON {author,body} per line (author-aware mode)")
    ap.add_argument("--trusted-author", help="with --comments-ndjson: only count markers authored by EXACTLY this login (empty => fail closed, nothing trusted)")
    args = ap.parse_args(argv)

    if args.comments_ndjson is not None:
        # Author-aware mode (the forged-marker-DoS fence): a marker counts only from the trusted
        # signer author. --trusted-author may be absent/empty => fail closed (nothing present).
        try:
            raw = open(args.comments_ndjson).read()
        except OSError as e:
            sys.stderr.write(f"review_gate_marker_present: cannot read comments ndjson: {e}\n")
            return 2
        cids = content_ids_in_authored(_read_ndjson_comments(raw), args.trusted_author or "")
        if args.content_id in cids:
            sys.stderr.write(f"review_gate_marker_present: marker for {args.content_id} PRESENT (trusted author {args.trusted_author!r})\n")
            return 0
        sys.stderr.write(f"review_gate_marker_present: no trusted marker for {args.content_id} (trusted author {args.trusted_author!r})\n")
        return 1

    try:
        text = open(args.comments_file).read() if args.comments_file else sys.stdin.read()
    except OSError as e:
        sys.stderr.write(f"review_gate_marker_present: cannot read comments: {e}\n")
        return 2

    if is_present(text, args.content_id):
        sys.stderr.write(f"review_gate_marker_present: marker for {args.content_id} PRESENT\n")
        return 0
    sys.stderr.write(f"review_gate_marker_present: no marker for {args.content_id}\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
