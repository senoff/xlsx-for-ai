# xlsx-for-ai — agent loading guide

xlsx-for-ai is a CLI that converts `.xlsx` files into rich text or JSON dumps for AI coding agents. It is **npm-published** (`xlsx-for-ai`, ~100+ downloads/day). A bad release has wider blast radius than a solo internal bug, so the discipline bar is higher.

## Always-load

1. **`README.md`** — what the tool does, supported flags, output formats.
2. **`REVIEW.md`** — the cross-family multi-review gate (run `npm run review` before commits to risk areas; see file for full list).
3. **`SECURITY.md`** — threat model + reporting policy.
4. **`WHY.md`** — product framing and audience.

## Load on relevance

- **`docs/`** — design notes for individual subsystems (telemetry, redactor, region autodetect, integrity pinning).

## Review gate (mandatory unless explicitly skipped)

Per `REVIEW.md`:

- **Before commit on risk areas** (engine seam, redactor, telemetry, CLI surface, `package.json` exports, security-relevant code, diffs >~50 lines): `npm run review`
- **Before `npm publish`:** `multi-review` against `git diff <last-tag>..main` plus the full test suite plus a fresh-dir clean-install smoke test.

Skip allowed only for the categories listed in `REVIEW.md` (typos, doc edits, single-line self-evident fixes, no-op version bumps).

CRITICAL and HIGH findings must be resolved before the change lands. MEDIUM findings get fixed unless the commit message explains why not.

## Repo posture

- Solo repo. Direct push to `main` is allowed within Bob's normal autonomy. PRs are encouraged for any change touching the review-gate risk areas above — eat your own cooking.
- Commits do **not** include a `Co-Authored-By: Claude` trailer (Bob 2026-06-10 — forward-only; existing trailered commits stay).
- No `--no-verify`, no `--amend` after the fact, no force-push. Append a new commit to fix things.
- Releases happen via the GitHub Actions `publish.yml` workflow, not local `npm publish`.
- **Publishing (2026-06-03 — superseded the prior manual gate):** `xlsx-for-ai` publishes follow the fleet-wide "publish-on-own-judgment if Grace-clean" rule per `~/CLAUDE.md`. Per-commit `grace-autofix-loop` clean + any blocking CRITICALs resolved → publish + mention what shipped in summary; don't ask first. The prior "Do not publish without Bob's explicit go" rule has been retired in favor of the Grace gate stack carrying the confidence. Pre-Grace builds still route through Grace first.

## Project tone

- Public OSS package — README, error messages, and CLI output are user-facing copy. Aim for plain English, no jargon.
- Audience is every Excel user, not enterprise/financial-pro niche. Don't anchor copy or architecture on enterprise compliance unless explicitly told.
- Never position the product against Microsoft. MSFT is not a competitor.

## Phase 1 harness (2026-05-27)

Inherit the standing rule in `~/CLAUDE.md` — Phase 1 observability + validation layer applies here. Concretely on this product:

- Spawn with `OTEL_SERVICE_NAME=<agent-name>` exported so traces land in Phoenix (http://127.0.0.1:6006) tagged by agent.
- Use `handoff-notify-wrap` instead of `handoff-notify`. Validation rejects malformed front-matter before push.
- Include `parent_handoff:` in every reply handoff. Form: basename of the parent (`from-X-to-Y-DATE-slug.md`).
- Iteration cap is auto-applied — but blocks only on cap AND thrashing.** Per-role defaults via OTEL_SERVICE_NAME: Conductor=500, Dev Managers=300, Worker Bees/Scout=30. Count alone does not stop legitimate long sessions; block fires only when count>cap AND last 10 calls are thrashing (same tool, no Edit/Write, or identical input 5x). Manual override via `CLAUDE_ITERATION_CAP=N` on the spawn line. Revised 2026-05-27.
- For pure exploration tasks (no writes needed), defer to Scout: `~/bin/spawn-scout-readonly.sh`. The principal types the question after the prompt opens.

## Phase 1.5 discipline (2026-05-27)

Builds on the Phase 1 harness rule. Three additional non-negotiables for every coding task:

1. **Commit-by-commit, not batch.** Code lands as a series of focused commits (~150 lines each, one logical concept per commit). A 1-commit PR is a doctrine violation. Commit message form: `<scope>: <imperative verb> <what>` (e.g. `data-cleaning: add NA-detection heuristics`). The branch's commit graph IS the documentation a senior dev reads to recover from a failure — write it that way.
2. **Per-commit diff-defect.** After each commit, run `~/bin/grace-autofix-loop` (Phase 2.1, deployed 2026-05-27). Wrapper invokes grace-review against HEAD vs HEAD~1, blocks on CRITICAL, escalates to wren after 3 attempts on the same SHA.
3. **Dry-run before ship.** Every deploy.sh accepts `--dry-run` (see `~/conductor/scripts/deploy-template.sh`). Before declaring done, run `~/bin/dry-run-deploy <script>` and pass.

**No-interrupt mode for 2026-05-27:** DO NOT ping Bob. For every decision you'd otherwise ping him on, call `~/bin/would-have-asked <agent> <kind> "<context>" "<question>" "<chosen default>"` and proceed with your smart default. Wren aggregates at end of day. If you are truly blocked (external API key, irreversible action), open a handoff to `wren` — Wren decides whether to escalate.

**Observability doctrine:** see `~/conductor/mechanisms/observability.md` for the canonical LiteLLM + OTEL + Phoenix/Langfuse pattern, per-agent setup, query reference, and operational lessons. Deployed Phase 1.1 (2026-05-27).
