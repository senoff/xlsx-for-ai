#!/usr/bin/env python3
"""Mutation proof for the MCP-stdio smoke harness (XLS-988).

Runs scripts/mcp_smoke.py — the SAME code the publish workflow's post-publish smoke
runs — against two controlled servers, with no network, no registry, and no publish:

  GREEN arm: a mock server that emits a >64KB tools/list line and exits on EOF.
             The harness MUST exit 0. This is the regression: the old
             sleep()+terminate() harness truncated that line into a false-RED;
             the fixed drain-via-communicate harness captures it whole.

  RED arm:   /bin/cat as the "server". cat echoes the request lines back and never
             produces a JSON-RPC *result*, so the harness MUST exit non-zero
             (MISSING RESPONSES). This proves the harness still fails on a genuinely
             broken server — the fix did not defang the check.

POSIX-only by construction: /bin/cat and the mock's shebang spawn are the POSIX path,
which is exactly where the truncation bug lived (the macOS smoke arm). Run on
ubuntu + macos in CI.
"""
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SMOKE = os.path.join(ROOT, "scripts", "mcp_smoke.py")
MOCK = os.path.join(HERE, "mock_mcp_server.py")


def _make_executable(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_harness(exe, fixture):
    """Invoke mcp_smoke.py as a subprocess; return its exit code (and echo output)."""
    proc = subprocess.run(
        [sys.executable, SMOKE, exe, fixture],
        capture_output=True, text=True, timeout=120,
    )
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    return proc.returncode


def main():
    failures = []

    with tempfile.TemporaryDirectory() as tmp:
        fixture = os.path.join(tmp, "t.xlsx")
        # The mock ignores the fixture's bytes; a placeholder path is enough.
        with open(fixture, "wb") as f:
            f.write(b"PK\x03\x04 placeholder fixture for the mock server")

        # --- GREEN arm: healthy server with a >64KB response ---
        _make_executable(MOCK)
        print("=== GREEN arm: mock server (>64KB tools/list) — expect exit 0 ===")
        green = _run_harness(MOCK, fixture)
        if green != 0:
            failures.append(f"GREEN arm FAILED: harness exit {green} (expected 0) — "
                            "the fix did not survive a large, whole response.")
        else:
            print("GREEN arm OK\n")

        # --- RED arm: /bin/cat never produces a result — expect non-zero ---
        print("=== RED arm: /bin/cat (no valid responses) — expect non-zero ===")
        red = _run_harness("/bin/cat", fixture)
        if red == 0:
            failures.append("RED arm FAILED: harness exit 0 against /bin/cat "
                            "(expected non-zero) — the check no longer has teeth.")
        else:
            print(f"RED arm OK (harness exited {red})\n")

    if failures:
        print("SELFTEST FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("SELFTEST PASSED: green drains a >64KB response, red still fails closed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
