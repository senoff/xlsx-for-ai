# Security policy

`xlsx-for-ai` is a developer CLI that parses untrusted `.xlsx` files on
end users' machines and emits text or JSON for AI coding agents. The
project's security posture is documented across three files; this one is
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

The latest published `2.x` minor on npm receives security fixes. Older
minors do not. Today that is `2.23.x`. If a fix requires a breaking change,
it is shipped as the next `2.x` minor and the prior minor is deprecated on npm.

| Version  | Status      | Security fixes |
|----------|-------------|----------------|
| 2.23.x   | current     | yes            |
| 2.0–2.22 | superseded  | no             |
| 1.5.x    | frozen      | no             |
| ≤ 1.4.x  | superseded  | no             |

## What this project considers a security issue

In scope:

- A maliciously crafted `.xlsx` that causes `xlsx-for-ai` to execute
  arbitrary code, exfiltrate data outside the workbook, write outside the
  current working directory, or hang indefinitely on input that should
  parse or fail in bounded time.
- A dependency in the production tree (`exceljs` and its parser stack,
  `xlsx`, `papaparse`, `@formulajs/formulajs`, `gpt-tokenizer`) shipping
  a known-bad version through `xlsx-for-ai`'s lockfile.
- An npm-publish vector — a re-published version of any production dep
  with bytes that differ from the lockfile's pinned integrity hash.

Out of scope:

- Bugs in the AI agent that *consumes* the output. We dump bytes; we do
  not vouch for what an LLM does with them.
- Performance issues on legitimate workbooks that happen to be very
  large. File a normal issue.
- Vulnerabilities in dev-only dependencies that cannot be reached from
  the published package surface (`files` in `package.json` controls
  what ships).

## How this is enforced

Three documents and two CI workflows do the work:

- `docs/INTEGRITY_PINNING.md` — the integrity-pinning contract: lockfile
  is source of truth, `npm ci --ignore-scripts` everywhere in CI, SRI
  hashes verified on every install, signature verification required on
  every dep-touching PR, daily drift sweep, audit allowlist policy.
- `FORK_READINESS.md` — the runbook for an upstream npm-account
  compromise (specifically, `@protobi/exceljs`, the soft fork we may
  adopt for pivot-table support). Covers triggers, pre-positioning, and
  the freeze/diagnose/decide/fork response.
- `.github/audit-allowlist.json` — the enumerated set of triaged
  high-or-critical advisories the audit gate intentionally suppresses,
  with rationale and reassess dates. Adding an entry is a security-policy
  change.
- `.github/workflows/audit.yml` — `npm audit` on every PR + a daily
  cron, gated against the allowlist.
- `.github/workflows/upgrade-verify.yml` — `npm audit signatures` plus a
  registry re-resolve check on every PR that touches `package.json` or
  `package-lock.json`. Catches the silent-republish vector.

If you are reporting a finding, naming which of these failed (or which
should have caught it) is helpful but not required.

## Threat model in one paragraph

The high-value attack against `xlsx-for-ai` is supply chain: an attacker
who compromises the npm publish credentials of `exceljs`, `@protobi/exceljs`,
or any package in the `exceljs-family` group can ship arbitrary code that
runs on every `npm install`. The next-highest is a malicious workbook
that leverages a parser bug in that same stack. We do not try to defend
against the OS being compromised, nor against the user's AI agent acting
on the output. Everything in `INTEGRITY_PINNING.md` and `FORK_READINESS.md`
exists to detect or recover from supply-chain compromise; everything in
the audit workflows exists to catch parser CVEs the moment they are
disclosed.
