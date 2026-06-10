# Security policy

`xlsx-for-ai` is a developer CLI and MCP server that reads local `.xlsx`
bytes and relays them to a hosted API, which parses the workbook and returns
text or JSON for AI coding agents. Parsing and rendering happen server-side;
the published client's only runtime dependency is `@modelcontextprotocol/sdk`.
The project's security posture is documented across two files; this one is
the entry point.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Email the maintainer at `support@xlsx-for-ai.dev` with:

- a description of the issue and its impact;
- a minimal reproducer (a workbook, command, or version pinning is ideal);
- whether you intend to disclose, and on what timeline.

You should expect an acknowledgement within 72 hours. If you do not hear
back, follow up — the inbox occasionally eats things.

This project has no embargo program and no CVE-issuing budget. Coordinate
disclosure expectations in your first message.

## Supported versions

The latest published `3.x` minor on npm receives security fixes. Older
minors do not. Today that is `3.2.x`. If a fix requires a breaking change,
it is shipped as the next `3.x` minor and the prior minor is deprecated on npm.

| Version  | Status      | Security fixes |
|----------|-------------|----------------|
| 3.2.x    | current     | yes            |
| 3.1.x    | superseded  | no             |
| 3.0.x    | superseded  | no             |
| 2.x      | superseded  | no             |
| 1.5.x    | frozen      | no             |
| ≤ 1.4.x  | superseded  | no             |

## What this project considers a security issue

In scope:

- `@modelcontextprotocol/sdk` or any package in the published client's
  dependency tree shipping a known-bad version through `xlsx-for-ai`'s
  lockfile, or an npm-publish vector — a re-published version of any tree
  package whose bytes differ from the lockfile's pinned integrity hash.
- The client executing arbitrary code, exfiltrating data beyond the
  workbook bytes it relays, or writing outside the current working
  directory when it saves output a tool produced.

Out of scope:

- Bugs in the AI agent that *consumes* the output. We relay bytes; we do
  not vouch for what an LLM does with them.
- Parser behaviour on the hosted API. The server repo owns the workbook
  parsing/rendering stack (`exceljs`, `xlsx`, formula engines) and its
  supply-chain and parser-CVE surveillance. Report API-side issues there.
- Performance issues on legitimate workbooks that happen to be very
  large. File a normal issue.
- Vulnerabilities in dev-only dependencies that cannot be reached from
  the published package surface (`files` in `package.json` controls
  what ships).

## How this is enforced

Two documents and two CI workflows do the work:

- `docs/INTEGRITY_PINNING.md` — the integrity-pinning contract: lockfile
  is source of truth, `npm ci --ignore-scripts` everywhere in CI, SRI
  hashes verified on every install, signature verification required on
  every dep-touching PR, daily drift sweep, audit allowlist policy.
- `.github/audit-allowlist.json` — the enumerated set of triaged
  high-or-critical advisories the audit gate intentionally suppresses,
  with rationale and reassess dates. Adding an entry is a security-policy
  change. (Empty today — the thin-client tree carries no triaged
  advisories.)
- `.github/workflows/audit.yml` — `npm audit` on every PR + a daily
  cron, gated against the allowlist.
- `.github/workflows/upgrade-verify.yml` — `npm audit signatures` plus a
  registry re-resolve check on every PR that touches `package.json` or
  `package-lock.json`. Catches the silent-republish vector.

If you are reporting a finding, naming which of these failed (or which
should have caught it) is helpful but not required.

## Threat model in one paragraph

The client reads the workbook's raw bytes and relays them over HTTPS without
parsing or interpreting them — it has no `.xlsx` parser to attack, so a
malicious workbook cannot leverage a parser bug in the client. The high-value
attack against the published client is therefore supply chain: an attacker who
compromises the npm publish credentials of
`@modelcontextprotocol/sdk` or any package in its transitive closure can
ship arbitrary code that runs on every `npm install`. Everything in
`INTEGRITY_PINNING.md` and the audit workflows exists to detect or recover
from that. The workbook-parsing attack surface — a malicious `.xlsx`
leveraging a parser bug — lives on the hosted API, not in the client, and
is owned by the server repo. We do not try to defend against the OS being
compromised, nor against the user's AI agent acting on the output.
