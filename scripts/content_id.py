#!/usr/bin/env python3
"""content_id — the canonical CONTENT_ID recipe for the publish-attestation gate (XLS-1778).

This is the XLS-1554 canonical CONTENT_ID recipe, vendored into xlsx-for-ai and de-graced
(grace-detach-inventory row 15: "rename; reuse in new gate" — the recipe is self-contained,
stdlib-only, with NO grace dependency). It MUST stay byte-identical to the recipe the review
workflow signs its attestation over, or a valid attestation would fail to verify (false
fail-closed) — hence CID_ALG is pinned and shared: an attestation whose cid-alg token mismatches
this value fails CLOSED rather than comparing across recipes.

CONTENT_ID = subject of every review attestation (RFC v3 §GLOBAL / §13.1): a position-stripped
per-file blob-hash set over the authored-file set — stable across a pure base advance (a rebase
that adds nothing to the authored diff), RED on any one-byte authored-content change.

CANONICAL RECIPE (RFC §3.1 v2.2):
    C = sha256(  git -c core.autocrlf=false diff --no-color --no-textconv --binary <base>...<head>
                 with every `^index ` (blob-hash) and `^@@ ` (hunk-position) line dropped  )
- `<base>...<head>` (THREE dots) diffs from the merge-base to head, so the CID is
  position-INDEPENDENT (survives a pure rebase) yet byte-EXACT on the changed text/context/binary.
- `--binary` + `--no-textconv` are REQUIRED: without them a true-binary `.xlsx` emits only
  "Binary files differ" and two distinct payloads on one path collide to one CID (false-positive).
- `core.autocrlf=false` keeps the bytes verbatim across platforms.

Exposed as `content-id <repo> <base> <head>` (prints the CID) and `--alg` (prints CID_ALG).
Zero third-party deps (stdlib only) so it runs anywhere both sides can.
"""
import hashlib
import subprocess
import sys

# Recipe version. Pinned to the XLS-1554 canonical value so this gate and the attestation
# producer share ONE recipe. Bump ONLY when the byte recipe below changes; an attestation
# carrying a different cid-alg fails closed (never cross-recipe compare).
CID_ALG = "1554-v2.2"


def _git(tree, *args):
    """(rc, stdout, stderr); never raises — an unmeasured id must SAY so, never traceback a gate."""
    try:
        p = subprocess.run(["git", "-C", str(tree), *args],
                           capture_output=True, text=True, timeout=120)
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return 1, "", "%s: %s" % (type(e).__name__, e)


def strip_volatile(diff_text):
    """PURE. Drop only the position/base-volatile header lines (`^index `, `^@@ `) so the CID is
    position-independent, keeping `diff --git` / `---` / `+++` (file identity), every `[ +-]` body
    line VERBATIM, and the GIT binary patch payload."""
    kept = [ln for ln in diff_text.split("\n")
            if not ln.startswith("index ") and not ln.startswith("@@")]
    return "\n".join(kept)


def content_id_from_diff(diff_text):
    """PURE. sha256 of the stripped diff. surrogatepass preserves the binary-patch payload bytes."""
    return hashlib.sha256(strip_volatile(diff_text).encode("utf-8", "surrogatepass")).hexdigest()


def content_id(tree, base, head):
    """CONTENT_ID for base...head in `tree`. '' on empty diff / git fault (=> caller fail-closes)."""
    rc, diff, _ = _git(tree, "-c", "core.autocrlf=false", "diff",
                       "--no-color", "--no-textconv", "--binary", "%s...%s" % (base, head))
    if rc != 0:
        return ""
    return content_id_from_diff(diff)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) == 1 and argv[0] in ("--alg", "--cid-alg", "-a"):
        sys.stdout.write(CID_ALG + "\n")
        return 0
    if len(argv) != 3:
        sys.stderr.write("usage: content-id <repo> <base> <head>   "
                         "(or --alg to print the recipe version)\n")
        return 2
    repo, base, head = argv
    cid = content_id(repo, base, head)
    if not cid:
        sys.stderr.write("content-id: could not compute CONTENT_ID for %s...%s in %s "
                         "(empty diff or git fault)\n" % (base, head, repo))
        return 1
    sys.stdout.write(cid + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
