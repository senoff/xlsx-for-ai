#!/usr/bin/env python3
"""A minimal MCP-stdio stand-in for the harness self-test (XLS-988).

It answers initialize / tools/list / tools/call with well-formed JSON-RPC and, crucially,
makes the tools/list result exceed the ~64KB pipe buffer — the exact condition that the
old sleep()+terminate() harness truncated into a false-RED. It exits on stdin EOF, so a
correct harness (close stdin -> drain via communicate) shuts it down gracefully.

Not a real MCP server: it ignores params and never touches the fixture. Its only job is
to reproduce the large-response + EOF-shutdown contract the real server exhibits.
"""
import json
import sys

# 70KB single result line — safely past the ~64KB pipe buffer, so a harness that does
# not drain concurrently will block the writer and (under the old code) truncate it.
BIG = "x" * 70000


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            m = json.loads(raw)
        except Exception:
            continue
        mid = m.get("id")
        if mid == 1:
            resp = {"jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": "2024-11-05", "capabilities": {},
                "serverInfo": {"name": "mock", "version": "1.0"}}}
        elif mid == 2:
            resp = {"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "pad", "description": BIG}]}}
        elif mid == 3:
            resp = {"jsonrpc": "2.0", "id": 3, "result": {
                "content": [{"type": "text", "text": "ok"}]}}
        else:
            continue  # notifications carry no id — nothing to answer
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    # stdin EOF -> return -> process exits (the graceful, EOF-driven shutdown path).


if __name__ == "__main__":
    main()
