#!/usr/bin/env python3
"""gate_config_hash — the shared gate-config-hash helper for the npm publish gate (XLS-1778 F).

This is a COPY-AND-OWN / rename vendoring (RFC v3 §8 detach, step-3) of card A's
`review_attest_lib.config_hash` (XLS-1774, senoff/xlsx-for-ai-server). Per the SysArch
Integration Contract (rfc-v3-gate-cards.md §13.1 / §152 + the 2026-09-24 F ruling), the
`gate_config_hash` is the ONE shared function C and F must call so their stale-config check
can never drift into a second detector — F must NOT reimplement it. Because F lives in a
DIFFERENT repo (xlsx-for-ai, the npm publish repo) than A's home module, "call the same code"
is realized here the same way the CONTENT_ID recipe was vendored into scripts/content_id.py:
a byte-identical copy of the algorithm, pinned to agree with the producer. Keep this function
in lockstep with A's review_attest_lib.config_hash — a divergence is a gate defect.

ALGORITHM (must match A exactly): deterministic sha256 over the gate-config file SET named in
the manifest (one repo-relative path per line; blank lines and `#` comments ignored). Each file
contributes `path\0<sha256hex(content)>\0` in byte-sorted path order. A missing manifest or any
missing listed file is fail-closed (nonzero exit): the config surface must be fully measurable
to honor an attestation (a stale-config attestation is a miss — RFC §13.1).

Usage:
  gate_config_hash.py <repo_root> <manifest_path>
Prints the hex digest to stdout; exits nonzero (with a diagnostic on stderr) if any listed
file — or the manifest itself — is absent, so the caller fail-closes.
"""

from __future__ import annotations

import hashlib
import os
import sys


def config_hash(repo_root: str, manifest_path: str) -> str:
    """sha256 over the manifest's file set. Byte-identical to A's review_attest_lib.config_hash."""
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(f"gate config manifest absent: {manifest_path}")
    paths: list[str] = []
    with open(manifest_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            paths.append(line)
    h = hashlib.sha256()
    root_abs = os.path.realpath(repo_root)
    for rel in sorted(paths, key=lambda p: p.encode("utf-8")):
        # Path-traversal guard (XLS-1778 F, SPM re-review): a manifest entry must be a repo-relative,
        # ..-free path — an absolute path or a `..` escape would read a file OUTSIDE repo_root. This
        # is REJECTION-ONLY: for any valid (relative, ..-free) manifest the resolved file is the same
        # one os.path.join would have read, so the digest stays byte-identical to A's
        # review_attest_lib.config_hash — only a malicious/malformed entry is refused (fail-closed).
        if os.path.isabs(rel):
            raise ValueError(f"gate config manifest entry is absolute (path traversal): {rel}")
        abs_p = os.path.realpath(os.path.join(root_abs, rel))
        if abs_p != root_abs and not abs_p.startswith(root_abs + os.sep):
            raise ValueError(f"gate config manifest entry escapes repo root (path traversal): {rel}")
        if not os.path.isfile(abs_p):
            raise FileNotFoundError(f"gate config file listed in manifest is absent: {rel}")
        with open(abs_p, "rb") as fb:
            file_sha = hashlib.sha256(fb.read()).hexdigest()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(file_sha.encode("ascii"))
        h.update(b"\0")
    return h.hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("usage: gate_config_hash.py <repo_root> <manifest_path>\n")
        return 2
    try:
        sys.stdout.write(config_hash(argv[1], argv[2]))
        return 0
    except Exception as e:  # noqa: BLE001 — any unmeasured config surface is fail-closed
        sys.stderr.write(f"gate_config_hash: {type(e).__name__}: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
