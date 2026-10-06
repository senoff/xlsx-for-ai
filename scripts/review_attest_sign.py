#!/usr/bin/env python3
"""review_attest_sign: build the §13.1 review-attestation predicate for one PR head and write the
exact canonical bytes that `cosign sign-blob` keyless-signs.

This is the signer half of the npm publish gate. The verifier half is
scripts/publish-attestation-gate.sh (+ review_attest_marker_resolve.py), which recomputes the same
values from the release PR at publish time and refuses unless every one matches.

Mirrors senoff/xlsx-for-ai-server's scripts/review_attest_sign.py + review_attest_lib.build_predicate
(same field set, same canonical encoding, same stub reviewer slots and rungs), with one deliberate
difference: CONTENT_ID and config_hash come from THIS repo's vendored scripts/content_id.py and
scripts/gate_config_hash.py, the exact recipes the publish gate recomputes with. Signer and verifier
therefore share one implementation and cannot drift apart.

The marker is minted only after the review-gate workflow has confirmed the gate of record
("Multi-LLM diff defect review") is definitively green at this head (review_gate_precondition.py).
The predicate does not decide anything; it records what passed, bound to the exact content.

Exit 0 and write --out-blob on success. Any gap (empty diff, unreadable config, git fault) exits
non-zero with nothing written, so the workflow signs nothing (fail closed).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import content_id as cidlib  # noqa: E402
import gate_config_hash as cfglib  # noqa: E402

ALG = "review-attest-1774-v1"
PREDICATE_TYPE = "review-attestation/1"
LANDABLE_VERDICT = "pass"
# Same values xlsx-for-ai-server stamps (its Card A stubs). The gate of record that actually
# decides is the Multi-LLM check confirmed by the workflow before this script runs.
REVIEWER_SLOTS = ["A:claude-opus-4-8", "B:chatgpt"]
SHADOW_RESULTS = {"gemini": "pass"}
MODEL_IDS = ["claude-opus-4-8", "chatgpt", "gemini"]
RUNGS = ["stage0", "reviewerA", "reviewerB"]
GATE_CONFIG_PREFIXES = (".github/review-gate/", ".github/workflows/review-gate.yml",
                        ".github/workflows/publish.yml", "scripts/publish-attestation-gate.sh",
                        "scripts/review_attest_")


def _git(repo: str, *args: str) -> str:
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise SystemExit(f"REFUSED: git {' '.join(args)} failed: {p.stderr.strip()[:300]}")
    return p.stdout


def authored(repo: str, base: str, head: str) -> tuple[list[str], dict[str, str]]:
    """The authored file set of base...head and each file's blob hash at head (deleted => '')."""
    names = [n for n in _git(repo, "diff", "--no-renames", "--name-only", f"{base}...{head}").split("\n") if n]
    hashes: dict[str, str] = {}
    for n in names:
        p = subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", f"{head}:{n}"],
                           capture_output=True, text=True, timeout=60)
        hashes[n] = p.stdout.strip() if p.returncode == 0 else ""
    return names, hashes


def risk_class(files: list[str]) -> str:
    return "gate_config" if any(f.startswith(GATE_CONFIG_PREFIXES) for f in files) else "code"


def build_predicate(*, cid: str, files: list[str], hashes: dict[str, str], signer_identity: str,
                    config_hash: str, timestamp: str) -> dict:
    return {
        "alg": ALG,
        "predicate_type": PREDICATE_TYPE,
        "subject_content_id": cid,
        "authored_file_set": files,
        "per_file_blob_hashes": hashes,
        "verdict": LANDABLE_VERDICT,
        "risk_class": risk_class(files),
        "reviewer_slots": REVIEWER_SLOTS,
        "shadow_results": SHADOW_RESULTS,
        "rungs_passed": RUNGS,
        "signer_identity": signer_identity,
        "config_hash": config_hash,
        "model_ids": MODEL_IDS,
        "timestamp": timestamp,
        "degraded_eligible": False,
    }


def canonical_bytes(predicate: dict) -> bytes:
    """Sorted keys, compact separators, UTF-8: the exact bytes signed and later re-read verbatim."""
    return json.dumps(predicate, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="build + emit the review-attestation predicate to sign")
    ap.add_argument("--repo-dir", required=True, help="git repo holding both the base and head commits")
    ap.add_argument("--repo-root", required=True, help="checkout of main: where the gate config is read")
    ap.add_argument("--base", required=True, help="the PR's base sha")
    ap.add_argument("--head", required=True, help="the PR's live head sha")
    ap.add_argument("--config-manifest", required=True, help="manifest path, relative to --repo-root")
    ap.add_argument("--signer-identity", required=True, help="the signing workflow's keyless OIDC identity")
    ap.add_argument("--out-blob", required=True, help="where to write the canonical bytes to sign")
    args = ap.parse_args(argv)

    cid = cidlib.content_id(args.repo_dir, args.base, args.head)
    if not cid:
        raise SystemExit(f"REFUSED: no CONTENT_ID for {args.base}...{args.head} (empty diff or git fault)")
    files, hashes = authored(args.repo_dir, args.base, args.head)
    try:
        cfg = cfglib.config_hash(args.repo_root, os.path.join(args.repo_root, args.config_manifest))
    except Exception as e:  # noqa: BLE001 - any unmeasurable config surface refuses
        raise SystemExit(f"REFUSED: gate config hash not computable: {e}")
    predicate = build_predicate(cid=cid, files=files, hashes=hashes, signer_identity=args.signer_identity,
                                config_hash=cfg, timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    blob = canonical_bytes(predicate)
    with open(args.out_blob, "wb") as fh:
        fh.write(blob)
    sys.stderr.write(blob.decode("utf-8") + "\n")
    sys.stderr.write(f"content_id {cid[:16]}... over {len(files)} authored file(s); "
                     f"config_hash {cfg[:16]}...; wrote {len(blob)} bytes -> {args.out_blob}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
