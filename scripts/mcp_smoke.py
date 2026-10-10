#!/usr/bin/env python3
"""MCP stdio post-publish smoke: initialize + tools/list + xlsx_read must all answer.

Single-sourced so the publish workflow's post-publish smoke and the harness self-test
(.github/workflows/smoke-selftest.yml) exercise the SAME drain logic — the mutation
proof is only meaningful if it drives the code that actually ships.

XLS-988 — what this fixes. The previous inline harness did:

    time.sleep(25); p.stdin.close(); p.terminate(); p.communicate(...)

which raced a large `tools/list` response: with 69 tools the result line exceeds the
~64KB pipe buffer, so the server BLOCKS mid-write while nothing drains stdout. The
sleep()+terminate() then SIGTERMs the server in the middle of that write, leaving a
truncated line in the pipe -> `json.loads` fails -> false-RED "PROTOCOL CORRUPTION"
on an artifact that is actually healthy (SPM clean-installed 4.0.0, 69 tools, exit 0).

The fix, per the card's shape:
  * close stdin exactly ONCE and let that EOF drive a graceful shutdown;
  * drain BOTH pipes via communicate(timeout=...), which reads stdout/stderr
    concurrently so a >64KB line can neither deadlock the pipe nor be truncated;
  * escalate to kill() ONLY on TimeoutExpired (the server ignored EOF).

communicate() owns the single stdin close, so there is no separate stdin.close() and
no terminate() to race the writer.
"""
import json
import os
import subprocess
import sys

# Give the server room to answer + exit on EOF before we treat silence as a hang.
# Generous because it is a hard ceiling only hit when the server misbehaves; the
# healthy path returns as soon as the server closes stdout (well under a second).
DRAIN_TIMEOUT_S = 60


def run(exe, fixture):
    # Windows: the npm bin shim is a .cmd — it must be spawned as a STRING with
    # shell=True (a list with shell=True is malformed on Windows). POSIX: spawn the
    # list with shell=False. (Cross-platform spawn contract carried from XLS-959.)
    if os.name == "nt":
        p = subprocess.Popen(
            exe + ".cmd",
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            shell=True,
        )
    else:
        p = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def send(o):
        p.stdin.write((json.dumps(o) + "\n").encode())
        p.stdin.flush()

    # These four writes are all small (< the pipe buffer), so they never block even
    # though nothing is draining stdout yet.
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                     "clientInfo": {"name": "ci-smoke", "version": "1.0"}}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
          "params": {"name": "xlsx_read",
                     "arguments": {"file_path": os.path.abspath(fixture)}}})

    # EOF-driven shutdown + concurrent drain. communicate() closes stdin exactly once
    # (server sees EOF and exits) and reads stdout+stderr to EOF without a blocking
    # single-pipe read — so the >64KB tools/list line is captured whole. kill() only
    # if the server never honours EOF within the window.
    try:
        out, err = p.communicate(timeout=DRAIN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()

    out = out.decode(errors="replace")
    err = (err or b"").decode(errors="replace")

    ok = {1: False, 2: False, 3: False}
    for line in out.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except Exception:
            print("PROTOCOL CORRUPTION on stdout:", line[:200])
            return 1
        if m.get("id") in ok and "result" in m:
            ok[m["id"]] = True
        if m.get("id") in ok and "error" in m:
            print("RPC ERROR id", m["id"], ":", str(m["error"])[:300])
            return 1

    missing = [k for k, v in ok.items() if not v]
    if missing:
        print("MISSING RESPONSES for ids:", missing)
        print("STDOUT was:", out[:1500])
        print("STDERR was:", err[:1500])
        return 1

    print("MCP stdio OK: initialize + tools/list + xlsx_read all answered")
    return 0


if __name__ == "__main__":
    exe = sys.argv[1] if len(sys.argv) > 1 else os.path.join("node_modules", ".bin", "xlsx-for-ai-mcp")
    fixture = sys.argv[2] if len(sys.argv) > 2 else "t.xlsx"
    sys.exit(run(exe, fixture))
