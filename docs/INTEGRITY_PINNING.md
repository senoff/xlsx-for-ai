# Integrity-hash pinning convention

`xlsx-for-ai` ships as a thin client: it reads local `.xlsx` bytes and relays
them to the hosted API, which does all parsing and rendering server-side. The
only runtime dependency is `@modelcontextprotocol/sdk`, so the published
client's supply-chain surface is that package plus its transitive closure —
everything that reaches end users on `npm install`. A silent re-publish of any
of those packages would run on our users' machines, which is what this contract
exists to detect. (The spreadsheet engines that parse untrusted workbook bytes
now live in the server repo; their supply-chain surveillance lives there too.)

This document is the contract this project follows to keep that boundary
tight. The CI workflows `.github/workflows/audit.yml` and
`.github/workflows/upgrade-verify.yml` enforce most of it automatically.

## The rules

1. **`package-lock.json` is committed and is the source of truth.**
   Every dependency, transitive or direct, must appear in the lockfile with
   a `resolved` URL and an `integrity` SRI hash (`sha512-...`). PRs that
   touch `package.json` without regenerating the lockfile are blocked by
   `upgrade-verify`.

2. **Installs always go through `npm ci`, never `npm install`, in CI and
   release tooling.** `npm ci` re-fetches every tarball and verifies the SRI
   hash. `npm install` will silently rewrite the lockfile if the registry
   serves new bytes, which defeats the whole point of pinning.

3. **No floating tags in the lockfile.** Range specifiers (`^4.4.0`) are
   fine in `package.json`, but every line in `package-lock.json` must
   resolve to a concrete version + integrity hash.

4. **Postinstall scripts are off in CI.** Workflows pass `--ignore-scripts`.
   If a dep needs a postinstall to function, that is a separate, explicit
   decision — not something a transitive dep gets to opt into silently.

5. **Signature verification is required for every dependency-touching PR.**
   `npm audit signatures` runs in `upgrade-verify.yml`. A failure means at
   least one package in the tree no longer has a valid registry signature
   or the registry served different bytes than what we have pinned.

6. **Major version bumps get a manual review.** Dependabot ships majors as
   their own PR (no grouping). The reviewer reads the upstream changelog and
   confirms the publish is legitimate before approving.

7. **Lockfile drift detection runs daily, in two layers.** `audit.yml` at
   11:17 UTC re-runs `npm ci` against the committed lockfile (catches
   anything that breaks the SRI compare). `upgrade-verify.yml` at 11:43
   UTC re-resolves every locked entry against the registry's currently
   advertised `dist.integrity` (catches a silent re-publish even when our
   cached SRI compare still passes). The two layers run on every PR that
   touches the lockfile *and* daily on `main`, so the 72-hour silent
   re-publish window is covered even during quiet weeks with no PRs.

8. **Triaged advisories live in `.github/audit-allowlist.json`.** Adding an
   entry is a policy change that goes through PR review, every entry has a
   `reassess` date, and the workflow auto-fails once an entry is past its
   reassess date. The allowlist exists for genuinely unfixable advisories
   in the dependency tree — not as a way to silence noise. (It is empty
   today; the thin-client tree carries no triaged advisories.)

## What "verification" actually checks

Three orthogonal things, in increasing order of strength:

| Check                              | What it catches                                             | Workflow              |
|------------------------------------|-------------------------------------------------------------|-----------------------|
| `npm ci` SRI hash compare          | Bytes served at install time differ from the lockfile hash. | both                  |
| `npm audit signatures`             | Tarball is not signed by the registry's current key, OR signature does not verify. | `upgrade-verify`      |
| Re-resolve every entry vs registry | Registry now advertises a different `dist.integrity` for the same `name@version` than we have pinned. | `upgrade-verify`      |

The third check is the silent-republish guard. npm allows a maintainer to
republish a version with new bytes within a 72-hour window after publish
(and longer for some legacy packages). The lockfile hash will still match
what we cached, but the registry's advertised hash will have changed. We
flag that.

## The audit allowlist

`.github/audit-allowlist.json` enumerates every high-or-critical advisory
that `audit.yml` will not block on, with the rationale and a reassess date.
Two rules:

- **Entries past their `reassess` date auto-expire.** The audit script in
  `audit.yml` checks every run and fails the build if any entry has a
  `reassess` value before today. This forces re-triage rather than letting
  exceptions ossify.
- **Adding an entry is a security-policy change.** PR review the rationale
  the same way you would review the underlying bug. "No upstream fix" is
  necessary but not sufficient — the entry must also explain why the
  advisory is acceptable in our specific use (e.g. attack surface, trust
  boundary, exploitability in our code path).

Moderate/low advisories do not need allowlisting today (the gate is
high+). If we ever tighten the gate, every then-active moderate advisory
will need the same triage treatment.

## Reacting to a verification failure

When `upgrade-verify` fails on a PR:

1. **Do not merge.** The check is the safety net.
2. Look at which package failed. If it is a Dependabot-opened bump:
   - confirm the version actually exists on the maintainer's GitHub
     release page or changelog;
   - check the maintainer's GitHub for any recent compromise notice
     (pinned issue, deleted release, force-pushed tag);
   - check `https://socket.dev/npm/package/<name>` for any new risk
     signals on this version.
3. If the cause is not a benign signing-key rotation:
   - **stop the upgrade** and pin back to the last-verified version;
   - file an issue on this repo tagged `security` describing what was
     observed.
4. If the evidence supports a benign cause (key rotation, regional CDN
   flap), re-run the workflow once. If it persists, escalate as in (3).

## When the lockfile *should* change

- Adding or removing a direct dep.
- A Dependabot PR (auto-regenerated lockfile, signatures must verify).
- A deliberate `npm update <pkg>` accompanied by a one-line note in the
  commit message explaining why.

Any other lockfile diff in a PR is suspicious and should be questioned in
review.

## When the lockfile should *not* change

- Editing `README.md`, `WHY.md`, or anything under `docs/`.
- Touching only `index.js` or test fixtures.
- Bumping CI workflow versions.

If the lockfile changed in one of those PRs, find out why before merging.

## Local development

`npm install` is fine locally. `npm ci` is required in:

- `.github/workflows/audit.yml`
- `.github/workflows/upgrade-verify.yml`
- any release script we add later (there is no automated prepublish flow
  today — releases are cut by hand via `npm publish` from a clean checkout
  and the maintainer is responsible for running the local check below
  beforehand)

If you want a local check that mirrors CI:

```sh
rm -rf node_modules
npm ci --ignore-scripts
npm audit signatures
```

That is the minimum bar. The CI workflows do the same thing plus the
registry re-resolve.
