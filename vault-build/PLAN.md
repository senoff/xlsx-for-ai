# Vault — Build PLAN (Phase 1 of 4)

*xlsx, 2026-05-28. Per ana's `Phase 0 accepted. Start Phase 1 — Vault.` directive. Spec at `~/ana/specs/vault.md` v1 (694 lines). Phase 0 platform module at `~/xlsx-for-ai-server/src/lib/platform/` (commits e8ad93e..b4671e4).*

## Build philosophy — hard gate first, full surface area second

Spec §10 has 23 acceptance criteria. Item 1 — the **Relevance & Precision Layer hard gate (≤20 findings on the canonical regression workbook)** — is the v1 ship gate. Everything else is bookkeeping if this fails.

Sequencing prioritizes:
1. **Detectors needed to hit the gate** — calc_chain_orphans + shared_string_ghosts (Mechanism 1 auto-handle); hidden_defined_names + hidden_columns_rows (Mechanism 2 density suppression); the 4-5 high-fire detectors that actually appeared in the 2026-05-20 regression workbook
2. **Mechanism 1 (auto-handle) + Mechanism 2 (density suppression)** — these turn 39,108 → ≤20
3. **`xlsx_vault_scan` route + ScanResult shape** — minimum to run the gate
4. **Hard gate test** — verify ≤20 against `~/ana/research/.../vault-regression-2026-05-20.xlsx`

After the gate passes:
5. Remaining 13 detectors (full §5.1 catalog)
6. Risk-tier matrix + clean-selection model + change_signature canonicalization
7. findings.xlsx 4-sheet layout
8. mode=clean execution path
9. comment_review (Haiku) — HERO capability per §6.4
10. xlsx_vault_get_receipt + xlsx_vault_rules routes
11. Slack + Teams hooks + DM-only grep audit
12. Corpus regression

## Estimate

Per [[agent-time-estimates-run-long]]: parallelizable workstreams set wall-clock by the longest agent, not by sum. Vault is mostly serial (each detector layer feeds the relevance layer feeds the route). Estimating 18-24 commits over ~3-4h Claude-time. ana's estimate was 3-4h; aligned.

## Phase shape

```
Phase 1.A — Hard-gate enablers      (commits 1-9; ≤20 findings on regression workbook)
Phase 1.B — Full detector catalog   (commits 10-14; remaining 13 detectors)
Phase 1.C — Clean mode + UX shell    (commits 15-19; mode=clean, findings.xlsx, change_signature)
Phase 1.D — Routes + surfaces        (commits 20-24; get_receipt, rules, Slack/Teams)
```

## Phase 1.A — Hard-gate enablers (commits 1-9)

| # | Commit | Module(s) | Notes |
|---|---|---|---|
| 1 | `vault: scaffold src/lib/vault/ + types + 18-detector catalog` | `src/lib/vault/{index.ts,types.ts,catalog.ts}` | Detector token enum (18); risk tiers; VaultFinding extends PlatformFinding; CleanSelection types |
| 2 | `vault: add Mechanism 1 auto-handlers — calc_chain_orphans + shared_string_ghosts` | `src/lib/vault/auto-handled/{calc-chain.ts,shared-strings.ts}` | Genuine-orphan-only filter for calc_chain (the 39k → 0 win); orphan-detection-from-sharedStrings.xml |
| 3 | `vault: add detect-hidden-sheets` | `src/lib/vault/detect/hidden-sheets.ts` | state=hidden\|veryHidden; runs per platform orchestrator |
| 4 | `vault: add detect-hidden-defined-names` | `src/lib/vault/detect/hidden-defined-names.ts` | Visible=false names; raw findings before suppression |
| 5 | `vault: add detect-hidden-columns-rows` | `src/lib/vault/detect/hidden-columns-rows.ts` | Runs not cells; outline-collapsed excluded; the 497-finding noise source |
| 6 | `vault: add Mechanism 2 density suppression — prefix clustering` | `src/lib/vault/relevance/density-suppression.ts` | Tokenization (alpha→digit transition + delimiter split); ≥25/500/10/50 thresholds; the IQ_*/wrn cluster collapsers |
| 7 | `vault: add detect-display-underlying-mismatch + detect-doc-metadata` | `src/lib/vault/detect/{display-mismatch.ts,doc-metadata.ts}` | The 47+5 finding source from regression workbook |
| 8 | `vault: add xlsx_vault_scan route — scan mode only` | `src/routes/xlsx-vault-scan.ts` | Minimum route to run gate; uses platformHarden + loadWorkbook; ScanResult-minus mode-clean fields |
| 9 | `vault: hard-gate test against canonical regression workbook` | `test/vault/hard-gate.test.ts` | Run the route against the 2026-05-20 workbook; assert ≤20 findings; assert auto_handled_summary counts |

**Phase 1.A ship signal:** commit 9's hard-gate test passes (≤20 findings).

## Phase 1.B — Full detector catalog (commits 10-14)

| # | Commit | Module(s) |
|---|---|---|
| 10 | `vault: add detect-white-text + detect-protection-theater + detect-comments-provenance` | `src/lib/vault/detect/{white-text.ts,protection-theater.ts,comments-provenance.ts}` |
| 11 | `vault: add detect-vba-present + detect-external-links + detect-custom-xml-parts` | `src/lib/vault/detect/{vba.ts,external-links.ts,custom-xml.ts}` |
| 12 | `vault: add detect-pivot-cache + detect-embedded-ole-objects + detect-tracked-changes` | `src/lib/vault/detect/{pivot-cache.ts,embedded-ole.ts,tracked-changes.ts}` |
| 13 | `vault: add detect-alternate-content-drift` | `src/lib/vault/detect/alternate-content.ts` |
| 14 | `vault: regression — full 18-detector catalog against synth fixtures` | `test/vault/full-catalog.test.ts` |

## Phase 1.C — Clean mode + UX shell (commits 15-19)

| # | Commit | Module(s) |
|---|---|---|
| 15 | `vault: add risk-tier matrix + per-detector cleaning actions` | `src/lib/vault/clean/risk-tier-matrix.ts` |
| 16 | `vault: add change_signature canonicalization` | `src/lib/vault/clean/change-signature.ts` |
| 17 | `vault: add CleanSelection model + precedence rules` | `src/lib/vault/clean/clean-selection.ts` |
| 18 | `vault: add findings.xlsx 4-sheet generator` | `src/lib/vault/output/findings-xlsx.ts` |
| 19 | `vault: mode=clean execution + ScanResult full shape` | `src/lib/vault/clean/execute.ts` |

## Phase 1.D — Routes + surfaces (commits 20-24)

| # | Commit | Module(s) |
|---|---|---|
| 20 | `vault: add xlsx_vault_get_receipt route` | `src/routes/xlsx-vault-get-receipt.ts` |
| 21 | `vault: add xlsx_vault_rules CRUD route` | `src/routes/xlsx-vault-rules.ts` |
| 22 | `vault: add comment_review (Haiku batched)` | `src/lib/vault/detect/comment-review.ts` |
| 23 | `vault: Slack + Teams hooks via platform DM helper` | `src/lib/vault/chat/{slack-hook.ts,teams-hook.ts}` |
| 24 | `vault: corpus regression + DM-only grep audit` | regression run |

## Per-commit gates (same as Phase 0)

- `npx vitest run test/vault/ test/platform/ test/clean/` no regressions
- `npx tsc --noEmit` clean
- `~/bin/grace-autofix-loop` returns 0 (no CRITICAL)

## Ship signal (Phase 1.D close)

1. Hard gate passes (Phase 1.A commit 9)
2. Full 18-detector catalog tests pass (Phase 1.B commit 14)
3. mode=clean writes new file with bit-identical original SHA (Phase 1.C commit 19)
4. xlsx_vault_get_receipt happy + 404 + 410 paths (Phase 1.D commit 20)
5. Corpus regression clean against Bob's 1047-file corpus (Phase 1.D commit 24)
6. DM-only grep audit clean

Post-Phase-1 handoff to spm per [[ping-spm-on-finish]]: corpus regression numbers + hard-gate finding count + the suppression breakdown (auto-handled vs density-suppressed vs flagged).

## Standing-rule acks (from Phase 0)

- `OTEL_SERVICE_NAME=xlsx`, `handoff-notify-wrap`, `parent_handoff:` on replies
- No real collaborator names in commits / PRs / READMEs
- No mocked DB in tests
- `GRACE_SKIP=1` only on grace cycling on over-elevation
- `~$*.xlsx` filter at every corpus discovery layer
- Coordinate mutation order discipline per platform §1

## Status

For execution — no sign-off gate required since ana already green-lit Phase 1 start. If structural issues surface mid-build, will route a mid-phase handoff to spm per [[ping-spm-on-finish]].
