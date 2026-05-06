# Review gate — xlsx-for-ai

xlsx-for-ai is npm-published. A bad release ships to every install on the next `npm i -g xlsx-for-ai@latest`, so the bar for what lands on `main` is higher than for a solo internal repo: every nontrivial diff gets cross-family adversarial review by GPT-5.5-pro + Gemini 2.5 Pro before commit, in addition to the existing test suite.

This is the per-diff complement to `/ultrareview`. Use ultrareview ~once a month for full-codebase sweeps; use `npm run review` constantly.

## When to run

**Required** before pushing to `main` (or merging the PR if you're using one) for any change that:
- touches the engine seam (`lib/engine.js`, anything that swaps the underlying xlsx library)
- touches the redactor or anything in `lib/redact*` / `tests/redactWorkbook-*`
- touches telemetry (`lib/telemetry*`, `tests/telemetry-*`)
- touches the CLI surface (`index.js`, `bin` field, argument parsing, output format flags)
- changes `package.json` `exports`, `files`, `bin`, or any field that affects what gets published
- adds or modifies anything security-relevant (path handling, formula evaluation, ZIP parsing, network egress)
- is more than ~50 lines of diff
- bumps a major or minor version

**Skip** for:
- typos in comments / strings / docs
- README / WHY.md / SECURITY.md / CHANGELOG copy edits
- single-character or one-line bug fixes that are self-evidently right
- patch-version no-op bumps with no code change

When in doubt, run it. It's $0.10–0.40.

## How

```bash
git add -A
npm run review
```

That runs the cross-family review against your staged diff, with the current branch name baked in as context. Output lands in `.review-out/` (gitignored).

For a full PR or feature-branch review (everything since `main` diverged):

```bash
git diff main...HEAD | multi-review -c "xlsx-for-ai: $(git rev-parse --abbrev-ref HEAD)"
```

For a release-time pre-publish sweep:

```bash
git diff $(git describe --tags --abbrev=0)..main | multi-review -c "xlsx-for-ai: pre-publish $(node -p "require('./package.json').version")"
```

## How to handle findings

Output is markdown with severity tiers (CRITICAL / HIGH / MEDIUM / LOW) and a `## What is missing` section.

- **CRITICAL or HIGH:** fix before commit/merge. No exceptions.
- **MEDIUM:** fix unless you have a specific reason not to. Note the reason in the commit message.
- **LOW:** judgment call. Often correct to leave for a follow-up.
- **What is missing:** if it's a missing test, a missing log line, or a missing validation, add it before commit.

When the two reviewers disagree (one flags CRITICAL, the other says trivially correct), trust the more specific finding. Vague disagreement = re-read the code yourself before commit.

## Pre-publish gate (release discipline)

Before `npm publish` (or before triggering the publish workflow):

1. Run the pre-publish review command above against `git diff <last-tag>..main`.
2. Resolve every CRITICAL/HIGH finding.
3. Run the full test suite (`npm test`).
4. `npm install /tmp/<tarball>` in a fresh dir to catch postinstall / missing-dep regressions.

This is human-followed discipline, not enforced by `prepublishOnly`. Reasons we do not block the publish on the API call:
- false negatives from Pro-tier rate limits would jam an urgent hotfix;
- a key file going missing on the publishing machine would jam every release;
- the cost belongs at decision time, not at the publish-script seam.

## Cost / sanity caps

- `multi-review` invocation: hard cap $1 per run. Typical: $0.10–0.40 with both reviewers on Pro tier.
- If you find yourself running it >10×/day on the same area, the diff is too big — break it down.

OpenAI and Gemini accounts are billed accounts (paid tiers active 2026-05-06). Free-tier Gemini Pro returns 429 on real usage; the gate assumes paid tier.

## What this is NOT

- Not a substitute for `/ultrareview` (monthly full-codebase pass — different scope).
- Not a substitute for the test suite. Both reviewers will sometimes miss a defect that a single test would catch.
- Not a permission to skip reading the diff yourself. The reviewer adds a second pair of eyes; it does not remove the first pair.

## Setup (one-time)

`~/bin/multi-review` and `~/bin/llm-review` are machine-wide and assume two API key files exist:

```bash
ls -la ~/.config/llm-keys/openai ~/.config/llm-keys/gemini
```

If either is missing, see `~/goddard/REVIEW.md` "Setup" section for provisioning steps. Both keys should be 600-permissioned.
