# xlsx-for-ai — Data Cleaning Addition · PLAN

*xlsx, 2026-05-27. Plan for the data-cleaning library + cleaner agent build per `~/work/handoffs/from-wren-to-xlsx-2026-05-27-data-cleaning-build.md`.*

This document is the build plan + decisions log. SPEC + TEST_PLAN per artifact are siblings (`SPEC.md` / `TEST_PLAN.md` for the library; `agent/SPEC.md` / `agent/TEST_PLAN.md` for the agent). The `grace-review -p spec-test-plan` gate runs on each pair before any code.

---

## Scope split — v1.0 / v1.1 (Bob 2026-05-27, late-day)

**v1.0 = foundational data-cleaning substrate.** Matches Ana's original greenlight framing ("v1 is the foundational data-cleaning substrate — NOT the full Prep product layer"). Ships:

- 7 detectors + transforms in `src/lib/clean/` (`na_variant`, `merged_cell_residue`, `type_coercion_mistake`, `trailing_row_noise`, `header_row_not_first`, `encoding_glitch`, `duplicate_header`)
- `synth_xlsx` fixture-fabrication framework + 12 synthetic fixtures
- `xlsx_data_clean` MCP tool + REST route + tools-list registration
- npm-package thin-client wiring (`--clean` flag + MCP tool)
- `cleaner` agent (Specialist with bounded writes; mode-split asks-and-shows; iteration cap=200)
- Real-corpus regression at Phase 5; §13 acceptance criteria
- Stateless from the server's perspective — no DB tables, no signature stamp, no re-upload flow, no pricing

**v1.1 = Prep product layer on top.** Carries the seven Bob/Ana strategic-thinking deltas from `~/ana/specs/prep.md`:

- Recipe artifact as **xlsx** (multi-sheet readable+editable replayable format; user-editable `exclude_next_time` column)
- **Signature stamp** injection into every cleaned output (`docProps/custom.xml` + `prep/signature.json` in the ZIP) — UUID, processed_at, library version, recipe_id, input_hash, output_hash
- **Server-side state** — `recipes` / `scans` / `users` tables
- **Re-upload detection** — extract signature on upload; branch on hash matches (output / input / neither); asks-and-shows replay-vs-fresh
- **Pricing matrix** for re-upload scenarios — exact-output free / original-input free / file-family $25 retail OR free Pro
- **Cloud-processed posture with 60-sec deletion** of uploaded file
- **Locked data-routing disclosure language**

v1.0 ships first; v1.1 is additive on top (the v1.0 lib core needs no rework). The split lets v1.0 corpus-validate on its own + Smarty out, signature, server-state, re-upload, pricing all get a clean v1.1 design pass once the lib core is proven.

**This PLAN.md governs v1.0 only.** v1.1 gets its own PLAN.md when v1.0 lands.

---

## What we're building (v1.0)

**Two artifacts, library first (load-bearing), agent on top.**

1. **Data-cleaning library** — server-side capability in `xlsx-for-ai-server` exposing a new `xlsx_data_clean` MCP tool + CLI `--clean` flag in the npm package. Given a `.xlsx` / `.csv` / `.tsv` / `.xls` / `.ods` file (via the existing upload pipeline), surfaces a structured manifest of detected data-grime issues, optionally executes a deterministic clean pass, and returns the cleaned data + audit-trail receipt.

2. **`cleaner` agent** — function-named specialist (per `[[feedback_function_named_agents]]`) that consumes a dirty file, invokes the library, presents a structured cleaning report to Bob, and supports the asks-and-shows interaction pattern for ambiguous calls. Peer to Heron/Magpie/Taco/HLPM in the registry.

## Why this lives where it lives

The npm package `xlsx-for-ai` is a thin client over `https://api.xlsx-for-ai.dev`. All heavy lifting lives in `xlsx-for-ai-server` (TypeScript / Fastify / ExcelJS). "Library addition" per Wren's directive = server-side capability in `xlsx-for-ai-server/src/lib/clean/` + thin-client wiring in `xlsx-for-ai/index.js` + `mcp.js`. Server-side is where parsing already happens; cleaning operates on a parsed workbook.

Distinct from existing `xlsx_doctor` tool — doctor diagnoses structure-preservation concerns (macros / hidden sheets / external links); data-clean transforms data-quality issues (NA variants / header inference / merged-cell residue / encoding glitches). Doctor is the "should I share this file" call; data-clean is the "is this dataset ready for downstream consumption" call.

## Decisions log (per would-have-asked 2026-05-27)

All three decisions logged this session — no-interrupt mode active.

| Decision | Default chosen | Rationale |
|---|---|---|
| Agent name | `cleaner` | Function-name per Bob's convention; descriptive; less ambiguous than `scrub` |
| MCP tool name | `xlsx_data_clean` | `xlsx-` prefix consistent with other tools; "data" distinguishes from doctor |
| Library subdir | `src/lib/clean/` | Shorter; consistent with `hardening/`, `stamp/` subdir naming |
| Default mode | diagnose-only with `--execute` opt-in | Mirrors doctor; informer-not-enforcer doctrine |
| Input shape | cache-uploaded file reference | Consistent with all other tools; supports csv/tsv via existing upload pipeline; .xls/.ods deferred to v1.1 |

## SPM review notes (2026-05-27, greenlit as-is)

SPM greenlit the plan with three notes folded back into this PLAN + the SPEC:

1. **Asks-and-shows is canonical at the agent layer — even in `--execute` mode.** Per `[[feedback-informer-not-enforcer]]` doctrine: cleaner walks every finding with proceed/modify/skip prompts before applying. The library's `mode=execute` is the *call* the agent makes after each per-finding confirmation; the library itself never auto-applies based on confidence tier. Agent SPEC §4.3 + §4.4 updated to reflect this.

2. **Leading-zero-stripped sub-shape (`type_coercion_mistake` sub-shape C) is never silent — always surfaces as a Finding with asks-and-shows confirmation.** SPEC §3.3 explicitly notes this; matched language now ties to the agent UX contract.

3. **Bench corpus can slot earlier in Phase 1 — between detector commits as they land, rather than batch-validated at the end.** Folded into the Phase 1 commit sequence: each detector commit pairs with its bench-fixture commit immediately after (so detector + fixture land together; the bench grows in lockstep with the lib).

**Framing clarification from SPM:** this v1 is the foundational data-cleaning library + cleaner agent — NOT the full Prep product layer. Don't pre-extract to open-source `xlsx-core` — let `src/lib/clean/` bake inside `xlsx-for-ai-server` first. The seven v1 detectors map cleanly into the Prep product layer when it lands; no re-architecture.

**v1.1 expansion targets (post-corpus regression, SPM-defined priority):** locale decimal/date inversion, leading-zero preservation refinement, 1900/1904 epoch, 15-digit IEEE 754 precision, 2-digit year ambiguity, NFC/NFD normalization, non-breaking/zero-width spaces, hidden rows/cols, dynamic array roundtrip, metadata leakage (overlap with Vault), pivot cache stale (overlap with Vault), gene/token auto-conversion. Not v1 blockers.

**Round-2 grace follow-ups** — SPM said "fold into Phase 1 if cheap; defer to v1.1 if not." Plan: fold the cheap ones (dup-header location consistency, fixture-count alignment, invalid-option error code, override-scope coordinate-space wording) into the SPEC during Phase 1 commit-0 (types + foundational shapes); defer the iterative tightenings to v1.1.

## Refinement 2 — Phase 3 → woven into Phase 1 (Ana 2026-05-27, Bob-promoted)

Ana's "Phase 3 → into Phase 1" handoff (`from-ana-to-xlsx-2026-05-27-phase-3-into-phase-1.md`) — Bob promoted the micro-suggestion to a directive: *"Do this the best way possible."* Folded into the Build sequence above. Phase 3 (separate bench corpus) dissolves; new Phase 0.5 builds the `synth_xlsx` + `assert_golden` fabrication framework; Phase 1 becomes pair-commits (fixture → detector) per detector. 12 fixture variants total per Ana's allocation table. Same commit-by-commit discipline + per-commit `grace-review -p diff-defect`; just adding a fixture-commit before each detector-commit.

The `synth_xlsx` framework is the reusable asset that makes v1.1 expansion cheap — when v1.1 adds the 11 gotcha handlers from Ana's expansion list, fixture creation is a parameter call away.

## Refinement 3 — Cleaner agent shape (Ana 2026-05-27, post-Wren-review)

Ana's `from-ana-to-xlsx-2026-05-27-cleaner-agent-shape-refinements.md` — Wren reviewed the agent posture and confirmed "approve with refinements, no architectural redesign." Five concrete refinements folded into `agent/SPEC.md`:

1. **Boundary posture named "Specialist with bounded writes"** — distinct from Scout (read-only) and Dev Manager (full-tool). Honest gap: `--allowed-tools` is per-tool, not per-path; path-scoping is doctrine convention at v1 (structural enforcement queued as Phase 2+).
2. **Asks-and-shows split by mode** — interactive (full three-option prompts: proceed/modify/skip); `--execute` / non-interactive (`would-have-asked`-style log + smart-default). Same decision logic; only surfacing differs.
3. **Iteration cap = 200** (Specialist tier, between Worker Bee 30 and Dev Manager 300). Register in `~/.claude/hooks/iteration-cap.sh`.
4. **Cross-agent invocation via handoffs ONLY**, not direct spawning. Caller writes `from-<caller>-to-cleaner-...`; cleaner picks up via inbox; cleaner writes `from-cleaner-to-<caller>-...` reply with `parent_handoff:` set. Cross-caller variations (retail/Pro/Enterprise) are CLI args/env vars on cleaner, not structural shape differences.
5. **Path-scoped Write is doctrine-only at v1** — Ana has separately routed the Phase 2.x structural-enforcement ticket to Wren; doesn't block v1.

Other Wren-confirmed details folded:
- **`KNOWN_AGENTS` already updated by Wren** — xlsx does NOT re-add `cleaner` to `~/bin/handoff_schema.py`.
- **Identity card location:** `~/.claude/cleaner-identity.md`.
- **Spawn script seed:** copy `~/bin/spawn-scout-readonly.sh`, adjust (extend ALLOWED_TOOLS with Edit + Write + explicit `mcp__xlsx-cleaner-*` tool names, point at cleaner-identity.md, distinct terminal color avoiding cyan + peach, export `OTEL_SERVICE_NAME=cleaner` + `CLAUDE_ITERATION_CAP=200`).
- **`cleaner` name confirmed** — don't rename; xlsx-for-ai namespace context disambiguates.

## Architecture

```
                                        ┌───────────────────────┐
                                        │ cleaner agent         │
                                        │ (orchestration layer) │
                                        │                       │
                                        │ - reads dirty file    │
                                        │ - invokes lib via MCP │
                                        │ - presents report     │
                                        └──────────┬────────────┘
                                                   │ MCP / REST
                                                   ▼
┌──────────────────────────┐         ┌────────────────────────────────┐
│ xlsx-for-ai (npm client) │ ───────▶│ xlsx-for-ai-server (hosted API)│
│ - thin CLI: --clean flag │   HTTPS │ - POST /api/v1/tools/          │
│ - MCP tool: xlsx_data_   │         │   xlsx_data_clean              │
│   clean                  │         │ - src/lib/clean/ module        │
└──────────────────────────┘         │   - detectors  (NA/merged/...) │
                                     │   - transforms (deterministic) │
                                     │   - manifest + receipt         │
                                     └────────────────────────────────┘
```

## Scope — v1 cleaning capabilities (per Wren's directive)

Seven detector/transform pairs to land at v1:

1. **NA variants** — normalize `"N/A"` / `"NA"` / `"n/a"` / `"-"` / `"null"` / `"NULL"` / blank / `"#N/A"` (Excel error) to a single canonical form.
2. **Merged-cell residue** — flatten merged-cell regions; forward-fill the merged value into the unmerged cells; surface the original merge geometry in the manifest.
3. **Type coercion mistakes** — detect cells where the format vs. value mismatches (numbers stored as text; dates stored as serial floats with no format; leading zeros stripped); offer per-column corrective coercion.
4. **Trailing-row noise** — detect and flag trailing rows containing footers / signatures / "Totals" rows / fully-empty rows after the last data row.
5. **Header-row inference** — detect when the header isn't on row 1 (preamble rows, multi-row headers, "Report title" cells); offer to lift the inferred header to row 1.
6. **Encoding glitches** — detect mojibake (`â€™` for `'`, `Ã©` for `é`); surface candidates with the suspected source encoding.
7. **Duplicate-header disambiguation** — detect when multiple columns share a name (common in CSV exports); rename collisions with deterministic suffixes (`Name`, `Name_2`, `Name_3`).

Each detector emits a `Finding` (location + type + suggested fix); the transform pass applies the fix deterministically when `--execute` is passed.

**Out of scope for v1:** semantic dedup (fuzzy-match on values), domain-specific transforms (these belong in Prep), PII redaction (lives in xlsx-for-ai-server's PII pipeline + xlsx-supervisor's PII Frisk), formula error propagation (xlsx-doctor / Healer territory).

## Build sequence

**Revised 2026-05-27 per Ana's "Phase 3 → woven into Phase 1" refinement (Bob promoted to directive).** Phase 3 dissolves; bench corpus is built into Phase 1 as fixture-then-detector commit pairs. Each detector lands against immediate validation. The `synth_xlsx` fabrication framework is the reusable asset that makes v1.1 expansion cheap.

**Phase 0 — Spec gate** *(done)*
1. ✅ `SPEC.md` + `TEST_PLAN.md` for the library
2. ✅ `agent/SPEC.md` + `agent/TEST_PLAN.md` for the agent
3. ✅ `grace-review -p spec-test-plan` — 2 rounds run; sent to SPM with round-2 follow-ups as fold-into-Phase-1-or-defer

**Phase 0.5 — Fixture fabrication framework (NEW)** *(~1-2 commits)*
4. `src/lib/clean/_test_fixtures/synth_xlsx.ts` — parameterized synthetic-xlsx generator: sheet count, row patterns, dirt types, encoding variants. Deterministic (seeded). The reusable asset.
5. `src/lib/clean/_test_fixtures/assert_golden.ts` — golden-output assertion framework: each fixture pairs with a small JSON-or-YAML expected-output file; the assertion engine compares detector output (findings array, sorted by type+location).

**Phase 1 — Library (pair-commits: fixture-then-detector)**

For each of the 7 detectors: ONE fixture-commit (fabricates the fixture variant(s) via `synth_xlsx` + writes the golden expected output) + ONE detector-commit (implements the detector to pass the golden assertion). 12 fixture variants total per Ana's allocation table; the fixture-commit may bundle multiple variants for a multi-sub-shape detector.

| # | Commit | Lines | Per-commit gate |
|---|---|---|---|
| 6 | `types.ts` — Finding / CleanResult / ChangeManifest + the SPM/grace round-2 follow-up fixes (dup-header location, fixture-count alignment, invalid-option error code, override-scope coordinate space) | ~120 | `grace-review -p diff-defect` |
| 7 | fixture: `na_variant` (2 variants — numeric-context column + mixed-blank cells) | ~100 | diff-defect |
| 8 | detector: `detect-na.ts` | ~120 | diff-defect against the fixtures |
| 9 | fixture: `merged_cell_residue` (1 variant) | ~80 | diff-defect |
| 10 | detector: `detect-merged.ts` | ~140 | diff-defect |
| 11 | fixture: `type_coercion_mistake` (3 variants — text-as-number / date-serial / leading-zero) | ~180 | diff-defect |
| 12 | detector: `detect-types.ts` | ~150 | diff-defect |
| 13 | fixture: `trailing_row_noise` (2 variants — footer block / mixed totals+blanks) | ~120 | diff-defect |
| 14 | detector: `detect-trailing.ts` | ~110 | diff-defect |
| 15 | fixture: `header_row_not_first` (1 variant — 3-row preamble) | ~80 | diff-defect |
| 16 | detector: `detect-header.ts` | ~140 | diff-defect |
| 17 | fixture: `encoding_glitch` (1 variant — mojibake bigrams) | ~80 | diff-defect |
| 18 | detector: `detect-encoding.ts` | ~100 | diff-defect |
| 19 | fixture: `duplicate_header` (2 variants — case-insensitive / trim-normalized) | ~100 | diff-defect |
| 20 | detector: `detect-dup-headers.ts` | ~80 | diff-defect |
| 21 | orchestrator: `src/lib/clean/index.ts` — run all detectors per §3.0 order; build manifest + receipt | ~150 | diff-defect |
| 22 | route: `src/routes/xlsx-data-clean.ts` — Fastify route wiring | ~120 | diff-defect |
| 23 | route registration: `src/routes/tools-list.ts` | ~10 | (trivial; auto-skip) |

= ~17 commits on the server side. Each pair-commit (fixture → detector) ships its detector against immediate validation; per-commit `diff-defect` catches contract issues at fixture stage before detector code lands.

**Phase 2 — Client wiring (npm package)**
24. `xlsx-for-ai/lib/clean.js` — thin client function: `callTool('xlsx_data_clean', body)`. (~50 lines)
25. `xlsx-for-ai/index.js` — `--clean` flag wiring. (~40 lines)
26. `xlsx-for-ai/mcp.js` — register MCP tool. (~30 lines)

**Phase 3 — OBSOLETE as a separate phase** (per Ana 2026-05-27). Bench corpus = the 12 synthetic fixtures (built into Phase 1) + the principal's real-corpus regression (Phase 5 dry-run-deploy still runs against real corpus for §12 gate validation).

**Phase 4 — Agent**
27. `~/conductor/roles/cleaner.md` — agent identity / role doctrine.
28. `~/bin/spawn-cleaner.sh` — spawn script with `OTEL_SERVICE_NAME=cleaner` + iteration cap.
29. Add `cleaner` to `~/bin/handoff_schema.py` `KNOWN_AGENTS`.
30. Add `cleaner` to `~/bin/handoff-notify` case statement.

(Phase 4 may be affected by Ana's pending `from-ana-to-wren-2026-05-27-cleaner-agent-shape-review.md` review with Wren — proceed when that's resolved or in parallel if it's a non-blocking refinement.)

**Phase 5 — Dry-run + change-report gate**
31. Write `~/xlsx-for-ai-server/scripts/deploy-xlsx-data-clean.sh` per `~/conductor/scripts/deploy-template.sh`.
32. `~/bin/dry-run-deploy` against it.
33. Real-corpus regression scan (principal's 1,096-workbook corpus) — same script shape as Vault/PII Frisk/Healer corpus runs; surfaces calibration data for the seed thresholds (`header_row_not_first` +3 margin, `type_coercion_mistake` 80% threshold, `trailing_row_noise` default=3). If Mechanism-2-style suppression is needed, design call back to SPM with the data.
34. `grace-review -p change-report` on the full diff vs `main`.

**Phase 6 — EOD handoff to wren**
35. Reply handoff per `parent_handoff:` doctrine; everything Wren asked for in §"Deliverables" of the directive.

## Wall-clock estimate (Claude time, post-Ana-refinement)

Library is now the dominant phase (~17 commits × ~8-12 min each w/ per-commit grace-review = ~2.5-3 hours). Phase 0.5 fixture-fabrication framework is ~30 min. Client wiring is ~20 min. Agent is ~20 min. Dry-run + corpus regression + change-report is ~45 min. **Total ~4-5 hours of Claude wall-clock** (slightly longer than the original estimate; the doubled commit count is offset by per-commit smaller scope and immediate validation preventing end-of-phase fixup work).

Parallelism is constrained: pair-commits (fixture → detector) are intrinsically sequential within each detector; across detectors there's some independence (`encoding_glitch` and `duplicate_header` don't depend on each other) but the orchestrator commit blocks on all detectors. Bench corpus parallelizes with client wiring (Phase 2) and agent (Phase 4). Net wall-clock savings with parallel agents: ~30 min.

## Risks + mitigations

- **TypeScript build wiring** — xlsx-for-ai-server uses ESM + `.js` import extensions in source. Detector files must match. Verify against an existing `src/lib/*/` subdir before committing.
- **ExcelJS streaming API limits** — detectors that need cross-row analysis (header inference, trailing-row noise) may need bounded full-row buffer. Phase 0 spec calls out memory budget per detector.
- **Bench fixture sourcing** — bench fixtures must NOT include Bob's actual customer data (memory: `feedback_no_real_names_in_repo_artifacts` + general privacy posture). Build synthetic fixtures that reproduce the grime patterns without the underlying data.
- **Iteration cap** — current session has accumulated tool calls from prior turns. If the cap (default 50) trips before the build completes, the spec-gate output + library commits-so-far + this PLAN.md are the EOD handoff payload; Bob can spawn `cleaner` agent (or fresh xlsx session with `CLAUDE_ITERATION_CAP=300`) to resume.

## References

- Directive: `~/work/handoffs/from-wren-to-xlsx-2026-05-27-data-cleaning-build.md`
- Doctrine: `~/conductor/mechanisms/spec-gated-builds.md`
- xlsx-for-ai CLAUDE.md: `~/xlsx-for-ai/CLAUDE.md`
- Standing rules: `~/CLAUDE.md` (Phase 1 harness, function-named agents)
- Server route prior art: `~/xlsx-for-ai-server/src/routes/xlsx-doctor.ts` (closest existing tool shape)
- Mechanism 2 discipline (for the corpus-validation step if/when applicable): `~/ana/analysis/mechanism-2-discipline.md`
