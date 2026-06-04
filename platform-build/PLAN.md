# Platform + 3 Products — Build PLAN

*xlsx, 2026-05-28. Build plan + decisions log per Ana's serial-sequence directive `from-ana-to-xlsx-2026-05-28-code-platform-and-3-products-vault-pii-frisk-healer.md`. Specs at `~/ana/specs/_platform.md`, `vault.md`, `pii-frisk.md`, `healer.md`.*

## Why serial (Ana's directive, not negotiable)

Per Bob 2026-05-28: serial Vault → PII Frisk → Healer eliminates the three-products-disagree-on-UX class that asymmetric parallel builds produce. Vault ships first as UX anchor; PII Frisk + Healer pattern-match against Vault's route in code. Parallel saves wall-clock but produces a refactor pass at v1.1. Serial costs ~2× wall-clock; avoids the refactor.

## Phase shape

```
Phase 0 — Platform module                                            ← DETAILED below
Phase 1 — Vault (UX anchor)                                          ← Placeholder (filled in after Phase 0 lands)
Phase 2 — PII Frisk (pattern-matched vs Vault)                       ← Placeholder
Phase 3 — Healer (pattern-matched vs Vault + PII Frisk)              ← Placeholder
Phase 4 — Full-portfolio corpus regression (after Phase 3)           ← Placeholder
```

**Repo:** `~/xlsx-for-ai-server`. Branch: direct commits to `main` per the autonomy rule (solo repo). Push when each phase clears its grace gate.

---

## Phase 0 — Platform module (`src/lib/platform/`)

**Spec:** `~/ana/specs/_platform.md` v1.

**Acceptance:** the 10 acceptance items in spec §20:
1. All 8 modules extracted; data-clean route imports from `platform/`; data-clean corpus regression still 99.6% with same finding counts
2. `SpecError` adopted across data-clean; prefixed-message codes removed
3. `runCanonicalPipeline` + `rebaseFindingsAfterCoordinateShift` documented + enforced; 3 reference bugs (§1.4) regression-tested
4. `atomic-write` shipped MCP-only POSIX; worst-case path tested (§11.4)
5. `bounded-scan` emits file identity on every timeout; tested
6. Synth fixtures used by data-clean tests; canonical projection invariants tested
7. Route middleware prevents forgetting hardening pass; verified via CI test
8. DM-only grep audit (§10.1) in CI
9. Per-surface caps + retention wired into request validation + storage GC
10. Product specs reference this; cross-product r3 CRITs cleared (Ana's side)

**Estimate:** 18-22 commits, ~4-5h Claude time. (Ana estimated 2-3h; that's tight given the regression-validation + middleware + atomic-write + tests scope. I'm budgeting wider.)

### Commit-by-commit

Each commit: ~150 lines / one concept; message `<scope>: <verb> <what>`; per-commit `~/bin/grace-autofix-loop` blocks on CRITICAL. Existing 189 clean-suite tests + typecheck stay green throughout.

| # | Commit | Module(s) | Notes |
|---|---|---|---|
| 1 | `platform: scaffold src/lib/platform/ directory + barrel re-export` | `index.ts` + dir tree | Empty placeholders for each submodule + a README pointing at the spec |
| 2 | `platform: add SpecError envelope + BASE_ERROR_CODES + HTTP mapping` | `error.ts` | §2 — typed `code` field; `toResponseBody()`; spec's full BASE_ERROR_CODES list verbatim |
| 3 | `platform: add ExcelJS helpers — loadWorkbook + landmine workarounds` | `exceljs-helpers.ts` | §17 — single `loadWorkbook(buf)` Buffer-cast site; clearRow helper; comment docs for 17.3 / 17.4 asymmetries |
| 4 | `platform: add validate/primitives + validate/base64` | `validate/primitives.ts`, `validate/base64.ts` | §3 — colLetterToNumber, parseCellRef, EXCEL_MAX_*, STRICT_BASE64_RE, validateFileB64 (strip ws → regex → reject %4===1) |
| 5 | `platform: add validate/enum + validate/sheets + validate/options` | `validate/enum.ts`, `validate/sheets.ts`, `validate/options.ts` | §3 — three composable validators |
| 6 | `platform: add validate/region + validate/acceptReject` | `validate/region.ts`, `validate/acceptReject.ts` | §3 — region with bounds-before-inverted ordering; area cap; mutual-exclusivity |
| 7 | `platform: add manifest accumulator (generic emptyMetadata + mergeMetadata)` | `manifest.ts` | §15 |
| 8 | `platform: add result envelope builder + status/verdict mapping` | `result.ts` | §6 — ProductResultBase + status/verdict mapping + array-presence invariant |
| 9 | `platform: add per-surface caps + retention + identity tables` | `caps.ts`, `retention.ts`, `identity.ts` | §§7-9 — lookup tables + helpers |
| 10 | `platform: add WorkbookHandle + OutputHandle + validation` | `handle.ts` | §§4-5 — presigned_url HMAC verify, ephemeral_id resolve, OutputHandle per-surface + MCP locality explicit field |
| 11 | `platform: add canonical orchestrate.ts — runCanonicalPipeline + rebaseFindingsAfterCoordinateShift` | `orchestrate.ts` | §1 — THE big one. CoordinateShiftDescriptor + central rebase + ctx-refresh contract. Reference impl from `clean/index.ts` |
| 12 | `platform: regression-test the 3 §1.4 mutation-order bugs` | `test/platform/orchestrate.test.ts` | Pin the 3 sub-bugs (ctx leak, worksheet model drift, finding location drift) as regression cases |
| 13 | `platform: add hardening typed contract + route middleware` | `hardening.ts` | §14 — typed re-export over `src/lib/hardening`; `platformRouteHandler` wrapper; failing-route CI smoke |
| 14 | `platform: add audit middleware (withAudit) + OTEL span-per-detector` | `audit.ts` | §16 — typed AuditContext; standardized audit_row fields |
| 15 | `platform: add chat/dm_helper.ts + DM-only grep audit CI step` | `chat/dm_helper.ts` + CI config | §10 + §10.1 — single canonical helper; grep audit fails on bypass |
| 16 | `platform: add atomic-write (POSIX in_place) + crash recovery` | `atomic-write.ts` | §11 — full 9-step rename sequence; worst-case + crash-recovery paths tested |
| 17 | `platform: add bounded-scan subprocess wrapper` | `bounded-scan.ts` | §12 — refactor `scripts/scan-one.ts` + `corpus-regression-clean.ts` to use platform helper; scan_failed emits file identity |
| 18 | `platform: move synth_xlsx fixtures from _test_fixtures/ to platform/fixtures/synth/` | `fixtures/synth/*.ts` | §13 — pure move + path updates; tests stay green |
| 19 | `platform: move assert_golden from _test_fixtures/ to platform/fixtures/golden/` | `fixtures/golden/*.ts` | §13 — pure move + path updates; tests stay green |
| 20 | `clean: refactor xlsx-data-clean route to import from platform/ (validators)` | `src/routes/xlsx-data-clean.ts` | Replace inlined validators with platform/validate; SpecError adopted; prefixed-codes removed |
| 21 | `clean: refactor orchestrator to use runCanonicalPipeline + central rebase` | `src/lib/clean/index.ts` | Use platform/orchestrate; ~30% smaller; behavior preserved |
| 22 | `clean: refactor route to use platformRouteHandler + audit/hardening middleware` | `src/routes/xlsx-data-clean.ts` | Final route shape; lines drop significantly. Regression: 189 tests pass + corpus 99.6% with same finding counts |

### Per-commit gates

- `npx vitest run test/` ≥ 189 passes (no regressions; new tests grow the count)
- `npx tsc --noEmit` clean
- `~/bin/grace-autofix-loop` returns 0 (no CRITICAL)

### Pre-push gate

After commit 22 lands and grace-autofix-loops are clean, push to `origin/main`. Expect pre-push grace to flag class-of-bugs across the wider diff; address per Wren's run-by-run discipline; `GRACE_SKIP=1` only when only over-elevation remains.

### Regression validation

After commit 22, re-run `npx tsx scripts/corpus-regression-clean.ts` against Bob's full corpus. **MUST match the 2026-05-28 baseline:**
- file_count: 1047 (or current, after lock-file filter)
- scan_completed: ≥ 1043 (99.6%)
- findings_by_type counts: same shape ± 1% drift
- duration_ms_p50: ≤ 100ms; p99: ≤ 10s
- detector_skip_count: 0

If counts drift more than 1%, the refactor changed behavior — investigate before phase 0 lands.

### Handoff to Ana after Phase 0 lands

Per Ana's "What I need back" item 2: heads-up so she confirms the platform module's TypeScript names match the spec's references. Key names to confirm:

- `SpecError` (§2.1) ✓
- `runCanonicalPipeline(steps, ctx)` (§1.5) ✓
- `rebaseFindingsAfterCoordinateShift(findings, descriptor)` (§1.5) ✓
- `CoordinateShiftDescriptor` (§1.2.1) ✓
- `boundedScanFile<R>(file, opts)` (§12.1) ✓
- `platformHarden(buffer, opts)` (§14.1) ✓
- `platformRouteHandler<Body>(validate, handler)` (§14.2) ✓
- `loadWorkbook(buf)` (§17.1) ✓
- `emptyMetadata` / `mergeMetadata` (§15.1) ✓
- `validateFileB64` (§3) ✓
- `WorkbookHandle` / `OutputHandle` (§§4-5) ✓
- `Timestamp` (§5) ✓
- `withAudit` / `buildAuditRow` / `AuditContext` (§16.1) ✓

If any name drifts during build, route an amendment handoff back to Ana; she updates the spec to match.

---

## Phase 1 — Vault (placeholder)

**Spec:** `~/ana/specs/vault.md` (694 lines).

**Estimate:** 3-4h Claude-time (largest of the 3 products: Relevance & Precision Layer + Mechanism 2 density suppression + comment_review hero capability).

**Filled in after Phase 0 lands.** High-level shape:

1. Vault types + detection catalog (16 default + Mechanism 1 auto-handled split)
2. Mechanism 1 detectors (calc_chain_orphans, shared_string_ghosts) → auto_handled_summary
3. Mechanism 2 density suppression (≥25 cluster, ≥500 wb, ≥10 run, ≥50 per-sheet thresholds)
4. Mechanism 3 dedup (exact match on type + location + name)
5. Mechanism 4 "Show me everything" surface
6. Risk-tier matrix + canonical cleaning actions (external_links freeze, vba strip, etc.)
7. `change_signature` canonicalization
8. comment_review via Haiku batched (degraded_detector key `comment_review_generator`)
9. findings.xlsx 4-sheet layout
10. `xlsx_vault_scan` + `xlsx_vault_get_receipt` + `xlsx_vault_rules` routes
11. All 4 surfaces (web anonymous, MCP, Slack, Teams) with DM-only chat
12. Hard gate: canonical regression workbook ≤20 flagged findings
13. Corpus regression: full Bob-corpus via bounded-scan

**Ship signal:** hard gate passes + corpus regression clean.

---

## Phase 2 — PII Frisk (placeholder)

**Spec:** `~/ana/specs/pii-frisk.md` (670 lines).

**Estimate:** 2-3h Claude-time (pattern-matched against Vault).

**Filled in after Phase 1 lands.** High-level shape:

1. Pattern-match against Vault's route shape (file naming xfafrisked, DM button shape, findings.xlsx 3-sheet variant — no Sheet 4 since no density suppression)
2. 16 detector catalog + per-type redaction
3. NER batching via Haiku
4. Tesseract OCR + embedded-object recursion + zip-bomb caps
5. Deterministic redaction order via (surface_priority, lex finding_id)
6. Cell + hyperlink interaction explicit
7. `detection_overrides` skip-detection-entirely semantics
8. 4 surfaces; DM-only chat
9. Corpus regression

**Ship signal:** corpus regression clean.

---

## Phase 3 — Healer (placeholder)

**Spec:** `~/ana/specs/healer.md` (841 lines).

**Estimate:** 3-4h Claude-time (largest by scope; heavily anchored to Vault + PII Frisk shape).

**Filled in after Phase 2 lands.** High-level shape:

1. Pattern-match against Vault + PII Frisk
2. 9 cure operations + diagnose (chain_collapse + modernize_to_pq deferred to v1.1)
3. PQ M-code credential redactor v1.0 (10 patterns; `credentials_redactor_version` in receipts)
4. Atomic in-place MCP-only POSIX (uses platform §11)
5. `xlsx_healer_search_for_moved_file` MCP-only (web does discovery client-side via File System Access API)
6. Stale-scan protection via `expected_input_hash`
7. structure_changed auto-rewrite criteria operationalized
8. 4 surfaces; DM-only chat
9. Corpus regression

**Ship signal:** corpus regression clean.

---

## Phase 4 — Full-portfolio corpus regression (after Phase 3)

**Estimate:** 1h.

All 4 products (Vault, PII Frisk, Healer, + v1.0 data-cleaning) against full corpus. Cross-product integration check: a file scanned through all 4 should not break under sequential processing.

This is Bob's earlier directive — when item 8 ships, run all of it.

---

## Standing-rules acknowledgments

Per Ana's reminders so they don't surface mid-build:

- **Phase 1 harness** (`~/CLAUDE.md`): `OTEL_SERVICE_NAME=xlsx` on spawn; handoffs via `handoff-notify-wrap`; iteration cap with `CLAUDE_ITERATION_CAP=N` override available
- **No real collaborator names** in repo artifacts (commits, PR bodies, READMEs, code comments) per `~/CLAUDE.md`
- **No mocked DB** in tests — integration tests hit real fixtures per v1.0 doctrine
- **`GRACE_SKIP=1` escape hatch** for asymptotic pre-push gates per platform §18
- **`~$*.xlsx` filter** at every corpus discovery layer (platform §17.5)
- **Coordinate mutation order** discipline per platform §1 — 10 v1.0 CRITs reduced to this class

## Wall-clock estimate (Claude-time, serial)

| Phase | Estimate |
|---|---|
| Phase 0 | 4-5h |
| Phase 1 — Vault | 3-4h |
| Phase 2 — PII Frisk | 2-3h |
| Phase 3 — Healer | 3-4h |
| Phase 4 — portfolio regression | 1h |
| **Total serial** | **13-17h** |

Ana's estimate was 11-15h; my wider band acknowledges the regression-validation work + atomic-write tests + cross-platform middleware test coverage.

## Status

**For Ana sign-off.** Once approved, xlsx begins Phase 0 commit 1.
