# Healer — Build PLAN (Phase 3 of 4)

*xlsx, 2026-05-28. Per ana's `Rel-strip ACCEPTED. Two-bug catch validates the pushback. Start Phase 3 — Healer.` Spec at `~/ana/specs/healer.md` (841 lines). Pattern-matches against Vault + PII Frisk per the serial-build doctrine.*

## Differences from Vault + PII Frisk

| Vault / PII Frisk | Healer |
|---|---|
| `xfavaulted` / `xfafrisked` filename | `xfahealed` |
| 4-sheet (V) / 3-sheet (PF) findings.xlsx | 4-sheet w/ Power Query connections sheet (Healer-specific) |
| `action_overrides` / `detection_overrides` | `cure_params` per CureOperation discriminated union |
| Multi-detector catalog | 9 cure operations (1-9 v1; 10-11 v1.1) |
| Generic finding shape | DiagnosticReport: References + Diagnoses + Cures + PQ |
| `applied_action: 'cleaned' \| 'redacted' \| 'flag'` | `applied_action: 'cured' \| 'flag' \| 'partial'` |

In-place MCP-only POSIX already built — Phase 0 commit 16 `atomic-write.ts` is the substrate.

## Phase shape

```
Phase 3.A — Detection + diagnosis (commits 1-5)
Phase 3.B — Cure + UX + close (commits 6-12)
```

## Phase 3.A commit list

| # | Commit | Modules |
|---|---|---|
| 1 | `healer: scaffold + types + cure-op catalog` | `src/lib/healer/{index,types,catalog}.ts` |
| 2 | `healer: detect external links + Reference model` | `detect/external-links.ts` |
| 3 | `healer: detect broken-references + structure_changed auto-rewrite criteria (§5.5)` | `detect/structure-classifier.ts` |
| 4 | `healer: detect Power Query connections + PQ M-code credential redactor v1.0 (10 patterns)` | `detect/pq-connections.ts`, `clean/pq-credential-redactor.ts` |
| 5 | `healer: diagnose orchestrator + DiagnosticReport (with Haiku plain_english_generator + degradation)` | `diagnose.ts` |

## Phase 3.B commit list

| # | Commit | Modules |
|---|---|---|
| 6 | `healer: cure framework + rename_move + pattern_bulk` | `cure/{execute,rename-move,pattern-bulk}.ts` |
| 7 | `healer: source-deleted recovery (3 sub-options) + no_cached_value guard` | `cure/source-deleted.ts` |
| 8 | `healer: permission_denied + structure_changed + format_change cures` | `cure/{permission-denied,structure-changed,format-change}.ts` |
| 9 | `healer: make_standalone (safe vs complex thresholds) + v1.1 deferrals` | `cure/make-standalone.ts` |
| 10 | `healer: xlsx_healer_search_for_moved_file (MCP-only) + findings.xlsx 4-sheet` | `search.ts`, `output/findings-xlsx.ts` |
| 11 | `healer: Receipt + Rules (credentials_redactor_version + expected_input_hash)` | `receipt.ts`, `rules.ts` |
| 12 | `healer: chat notify + §10 acceptance matrix — Phase 3 close` | `chat/notify.ts` + acceptance test |

## Per-commit gates

- `npx vitest run test/healer/ test/pii_frisk/ test/vault/ test/platform/ test/clean/` no regressions
- `npx tsc --noEmit` clean
- `~/bin/grace-autofix-loop` returns 0 (no CRITICAL)

## Spec gotchas (per ana 2026-05-28)

1. 9 cure operations v1; chain_collapse (10) + modernize_to_pq (11) → `400 operation_not_available_in_v1`
2. `xlsx_healer_search_for_moved_file` MCP-only; non-MCP → `400 fuzzy_search_unsupported_on_surface`
3. `in_place` mode MCP-only POSIX; non-MCP / Windows → `400 surface_does_not_support_in_place` / `400 in_place_requires_posix_host`
4. `credentials_redactor_version: 'v1.0'` in every receipt
5. `expected_input_hash` mismatch → `409 stale_scan_baseline`
6. `source_deleted_freeze` / `source_deleted_localize` with no cached value → `400 no_cached_value`
7. `make_standalone`: safe = single-cell / static ≤100 / defined-name ≤100; complex = entire col/row / dynamic-array / >100 / cross-sheet / PQ
8. `structure_changed` auto-rewrite: 4 conditions ALL must hold per §5.5
9. Cure idempotency: same (scan_id, op, params) → cached output_hash; `cure_actions_taken[]` empty on idempotent re-call
10. Haiku plain_english_generator degradation → `partial` + `degraded_detectors: ['plain_english_generator']`

## Standing rule acks

Same as Phase 0/1/2 — OTEL, handoff-notify-wrap, parent_handoff, no real names, no mocked DB, GRACE_SKIP cycling-only, ~$*.xlsx filter, coordinate mutation order discipline.

## Status

For execution — ana already green-lit Phase 3 start. Standing by for the Phase 3 close handoff with the §10-equivalent acceptance matrix.
