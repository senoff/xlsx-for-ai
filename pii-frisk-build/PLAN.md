# PII Frisk — Build PLAN (Phase 2 of 4)

*xlsx, 2026-05-28. Per ana's `Vault Phase 1 ACCEPTED. Start Phase 2 — PII Frisk.` directive. Spec at `~/ana/specs/pii-frisk.md` (670 lines). Pattern-matches against Vault's route shape, file naming, findings.xlsx layout, DM action buttons.*

## Differences from Vault (template-match awareness)

| Vault | PII Frisk |
|---|---|
| `xfavaulted` filename | `xfafrisked` filename |
| Mechanism 1 + 2 (auto-handle + density suppression) | NO suppression — every detection IS a finding |
| 4-sheet findings.xlsx (incl. Suppressed) | 3-sheet (Summary + Flagged + Auto-handled-placeholder) |
| `action_overrides` (downgrade after detection) | `detection_overrides` (SKIP detector entirely) |
| Multi-stage clean execution from selection | Two-phase `xlsx_pii_clean(scan_id, finding_ids?)` |
| Risk-tier matrix per detector | Full-cell replace per type_key (no tiers in v1) |

Otherwise: same platform foundation, same DM-only chat surface, same Receipt+TTL pattern, same Rules CRUD pattern.

## Phase shape

```
Phase 2.A — Detectors + scan orchestrator (commits 1-10)
Phase 2.B — Redaction + UX + routes (commits 11-15)
```

## Phase 2.A commit list

| # | Commit | Modules |
|---|---|---|
| 1 | `pii-frisk: scaffold + types + 16-detector catalog` | `src/lib/pii_frisk/{index,types,catalog}.ts` |
| 2 | `pii-frisk: add SSN + credit_card detectors (regex + Luhn)` | `detect/{ssn,credit-card}.ts` |
| 3 | `pii-frisk: add bank_iban + bank_acct_us + routing_us detectors` | `detect/{bank-iban,bank-acct,routing}.ts` |
| 4 | `pii-frisk: add government_id + email + phone_international detectors` | `detect/{government-id,email,phone}.ts` |
| 5 | `pii-frisk: add dob + employee_id + financial_acct_ref + health_adjacent detectors` | `detect/{dob,employee-id,financial-acct,health-terms}.ts` |
| 6 | `pii-frisk: add doc_metadata_pii detector` | `detect/doc-metadata-pii.ts` |
| 7 | `pii-frisk: add name_person + address_physical detectors (NER via Haiku + degradation)` | `detect/{name-person,address-physical}.ts` |
| 8 | `pii-frisk: add image_ocr_pii detector (Tesseract stub + top-3)` | `detect/image-ocr.ts` |
| 9 | `pii-frisk: scan orchestrator + ScanResult + detection_overrides` | `scan.ts` |
| 10 | `pii-frisk: hard-gate test + dedup + cell/hyperlink ordering` | `test/pii-frisk/hard-gate.test.ts` |

## Phase 2.B commit list

| # | Commit | Modules |
|---|---|---|
| 11 | `pii-frisk: redaction strategy table + clean executor` | `clean/{strategies,execute}.ts` |
| 12 | `pii-frisk: findings.xlsx 3-sheet generator` | `output/findings-xlsx.ts` |
| 13 | `pii-frisk: Receipt + getReceipt + Rules CRUD` | `receipt.ts`, `rules.ts` |
| 14 | `pii-frisk: Slack + Teams chat notify (xfafrisked patterns)` | `chat/notify.ts` |
| 15 | `pii-frisk: §12 acceptance matrix — Phase 2 close` | `test/pii-frisk/phase-2-acceptance.test.ts` |

## Per-commit gates

- `npx vitest run test/pii_frisk/ test/vault/ test/platform/ test/clean/` no regressions
- `npx tsc --noEmit` clean
- `~/bin/grace-autofix-loop` returns 0 (no CRITICAL)

## Spec gotchas (per ana 2026-05-28)

1. `detection_overrides` skips detector ENTIRELY; no `suppressed_count` field
2. All redactions full-cell replace at v1; formula cells: cached `<v>` only
3. Cell+hyperlink interaction: deterministic `(surface_priority, lex finding_id)`; hyperlink (1) before cell (2)
4. NER batching: Haiku 50/req; failure → regex-only fallback + `status: 'partial'` + `degraded_detectors: ['ner_name', 'ner_address']`
5. Tesseract: top-3 (name/SSN/CC) at v1
6. Embedded-object depth 1; caps 100 objects / 50MB / 100× expansion

## Standing rule acks

Same as Phase 0 + Phase 1 — OTEL, handoff-notify-wrap, parent_handoff, no real names in artifacts, no mocked DB, GRACE_SKIP only on cycling, ~$*.xlsx filter, coordinate mutation order discipline.

## Status

For execution — ana already green-lit Phase 2 start. Standing by for the Phase 2 close handoff with the §12 acceptance matrix + cross-spec UX consistency confirmation.
