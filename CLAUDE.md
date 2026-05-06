# xlsx-for-ai — agent loading guide

xlsx-for-ai is a CLI that converts `.xlsx` files into rich text or JSON dumps for AI coding agents. It is **npm-published** (`xlsx-for-ai`, ~100+ downloads/day). A bad release has wider blast radius than a solo internal bug, so the discipline bar is higher.

## Always-load

1. **`README.md`** — what the tool does, supported flags, output formats.
2. **`REVIEW.md`** — the cross-family multi-review gate (run `npm run review` before commits to risk areas; see file for full list).
3. **`SECURITY.md`** — threat model + reporting policy.
4. **`WHY.md`** — product framing and audience.

## Load on relevance

- **`FORK_READINESS.md`** — engine-seam context (we ship `@protobi/exceljs`; alternative engines vetted and rejected).
- **`docs/`** — design notes for individual subsystems (telemetry, redactor, region autodetect).

## Review gate (mandatory unless explicitly skipped)

Per `REVIEW.md`:

- **Before commit on risk areas** (engine seam, redactor, telemetry, CLI surface, `package.json` exports, security-relevant code, diffs >~50 lines): `npm run review`
- **Before `npm publish`:** `multi-review` against `git diff <last-tag>..main` plus the full test suite plus a fresh-dir clean-install smoke test.

Skip allowed only for the categories listed in `REVIEW.md` (typos, doc edits, single-line self-evident fixes, no-op version bumps).

CRITICAL and HIGH findings must be resolved before the change lands. MEDIUM findings get fixed unless the commit message explains why not.

## Repo posture

- Solo repo. Direct push to `main` is allowed within Bob's normal autonomy. PRs are encouraged for any change touching the review-gate risk areas above — eat your own cooking.
- All commits include `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- No `--no-verify`, no `--amend` after the fact, no force-push. Append a new commit to fix things.
- Releases happen via the GitHub Actions `publish.yml` workflow, not local `npm publish`. Do not publish without Bob's explicit go.

## Project tone

- Public OSS package — README, error messages, and CLI output are user-facing copy. Aim for plain English, no jargon.
- Audience is every Excel user, not enterprise/financial-pro niche. Don't anchor copy or architecture on enterprise compliance unless explicitly told.
- Never position the product against Microsoft. MSFT is not a competitor.
