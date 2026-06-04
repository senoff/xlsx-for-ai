# xlsx-for-ai — Data Cleaning Library · TEST_PLAN

*xlsx, 2026-05-27. Test strategy for the `xlsx_data_clean` tool + bench corpus.*

## 1. Test taxonomy

Three layers:

1. **Unit tests** — one per detector, one per transform. Vitest, in `~/xlsx-for-ai-server/test/clean/`.
2. **Integration tests** — full pipeline through the `POST /api/v1/tools/xlsx_data_clean` route. Vitest, in `~/xlsx-for-ai-server/test/routes/xlsx-data-clean.test.ts`.
3. **Bench corpus** — real-shape dirty fixtures + golden outputs. Lives in `~/xlsx-for-ai/data-cleaning-test-bench/`. Round-trip `dirty → clean → assert against golden`.

Plus a small **smoke test suite** in the npm package for the `--clean` CLI flag (`~/xlsx-for-ai/test/v2/clean-cli.test.js`).

## 2. Unit tests — per detector

Each detector gets a `.test.ts` file in `test/clean/` with the shape:

```typescript
import { describe, it, expect } from 'vitest';
import { detectNaVariants } from '../../src/lib/clean/detect-na.js';

describe('detect_na_variants', () => {
  it('flags N/A in a numeric-context column (≥60% values parse as Number())', () => { ... });
  it('flags case-insensitive variants (N/A, n/a, NA)', () => { ... });
  it('does not flag legitimate "N/A" string in a text-only column (<60% numeric)', () => { ... });
  it('handles Excel #N/A error cell', () => { ... });
  it('treats single-period . as NA only in numeric-context columns', () => { ... });
  it('emits Finding.id stable across re-runs of the same input', () => { ... });
});
```

(Canonical-fingerprint determinism is asserted at the transform / integration layer — see §9 — NOT in detector unit tests. Detector tests assert only detection logic + Finding.id stability.)

**Required test coverage per detector (7 detectors × ~6 tests each = ~42 unit tests):**

| Detector | Positive cases | Negative cases | Edge cases |
|---|---|---|---|
| `na_variant` | `N/A`, `NA`, `null`, `-`, `#N/A`, `--`, single `.` in numeric col | Legitimate "N/A" string in text col; "n/a" in a survey-response col with `--no-detect` opt | Empty string vs blank cell; whitespace-only |
| `merged_cell_residue` | Horizontal merge (2×1); vertical merge (1×2); rectangular merge (3×3) | Single-cell "merge" (1×1); styled-header merge with `preserve_merges_in_sheets` | Nested merges; merge crossing the header row |
| `type_coercion_mistake` | Number-as-text; date-as-serial-float; leading-zero stripped from zip code | Already-correct numeric column; date-formatted serial; text column with mixed types | Mixed-type column (some numbers, some text — should not auto-coerce); negative numbers stored as text |
| `trailing_row_noise` | "Total" row at bottom; signature row; ≥3 blank rows at bottom | Single non-trailing footer; data row whose value happens to match "Total" pattern | Multi-sheet workbook with footer on only some sheets |
| `header_row_not_first` | Title in row 1, data starts row 3; multi-row header; report-preamble | Already-correct header on row 1; sheet with no data; sheet with single row | Headers across multiple rows (rows 1+2 both look header-y); merged-cell header banner |
| `encoding_glitch` | `â€™` in a name field; `Ã©` in an address; `Â ` prefix | Genuinely-multilingual content with proper UTF-8; emoji content | Mixed glitch + non-glitch in same cell |
| `duplicate_header` | Two `Name` columns; case-only diff (`Name` vs `name`); whitespace diff | Distinct headers; single unique column | Three+ duplicates; empty header in addition to duplicate |

## 3. Integration tests — route layer

`test/routes/xlsx-data-clean.test.ts`:

**Happy paths:**
- POST with valid xlsx handle + `mode=diagnose` → 200; `output_file_handle === null`; input cache bytes unchanged (byte-equality assert).
- POST with valid xlsx handle + `mode=execute` (findings → fixes applied) → 200; `output_file_handle` non-null; cleaned file readable via cache-download.
- POST with valid xlsx handle + `mode=execute` (zero findings) → 200; `output_file_handle === null`; `applied_count === 0`.
- POST with `detectors=["na_variant"]` → only `na_variant` runs; `findings_count_by_type` contains only that key.
- POST with `sheets=["Sheet1"]` → only that sheet scanned; `statistics.sheets_scanned === 1`.

**Format scope (per SPEC §1):**
- POST with `.csv` upload → 200; single-sheet workbook semantics; `merged_cell_residue` detector silently emits zero findings (csv has no merges).
- POST with `.tsv` upload → 200; same shape as csv.
- POST with `.xls` upload → 400 + `unsupported_format` (deferred to v1.1).
- POST with `.ods` upload → 400 + `unsupported_format` (deferred to v1.1).
- POST with `.pdf` renamed to `.xlsx` → 400 + `unsupported_format` (envelope check).

**Failure paths:**
- POST with expired file handle → 404 + `file_not_found`.
- POST with file >50MB → 413 + `file_too_large`.
- POST without auth → 401.
- POST with rate-limit exceeded → 429.

**Invalid-parameter handling (per SPEC §2.1):**
- POST with `detectors=[]` (empty array) → 400 + `empty_detector_list`.
- POST with `detectors=["bogus_detector"]` → 400 + `unknown_detector`.
- POST with `sheets=["NonexistentSheet"]` → 400 + `unknown_sheet`.
- POST with `options.trailing_threshold=-1` → 400 + `invalid_option_value`.
- POST with `options.trailing_threshold=999` → 400 + `invalid_option_value` (over max 100).
- POST with `options.header_scan_depth=0` → 400 + `invalid_option_value`.
- POST with `options.na_canonical=42` → 400 + `invalid_option_value` (non-string).
- POST with `accept_findings=["x"]` + `reject_findings=["y"]` → 400 + `conflicting_finding_selection`.
- POST with `overrides[0].scope` having both `column_letter` and `region` → 400 + `ambiguous_override_scope`.
- POST with `mode=diagnose` + `accept_findings=[...]` → 200 (silently ignored; not an error per SPEC).

**Response-shape invariants:**
- `sum(findings_count_by_type values) === findings.length`.
- `applied_count + failed_count + skipped_count === findings.length` (execute mode).
- `applied_count === 0` ↔ `output_file_handle === null` (execute mode).
- `findings_count_by_type` keys ⊆ requested-or-defaulted detector tokens.
- `statistics.detectors_run` array matches `findings_count_by_type` keys.

**Registration:**
- `tools-list` route includes `xlsx_data_clean` after registration.

## 4. Bench corpus — real-shape fixtures

Lives at `~/xlsx-for-ai/data-cleaning-test-bench/`. Each fixture has three companion files:

```
fixture-N/
├── dirty.xlsx           # the input
├── expected.json        # expected findings array (sorted by type + location)
├── golden.xlsx          # expected cleaned output (canonical fingerprint asserted)
```

**Required fixtures (12 at v1 — 10 single-detector + 1 combined + 1 csv):**

1. **na-variants-mixed.xlsx** — numeric-context column with mixed `N/A` / `NA` / `--` / `null` / blank values + a text-context column with legitimate `"N/A"` strings (the latter MUST NOT flag).
2. **merged-cells-banner.xlsx** — sheet with a 3-row merged title banner above the data table.
3. **merged-cells-row-headers.xlsx** — left-column row headers using vertical merges.
4. **type-mistakes-zip.xlsx** — zip-code column with stripped leading zeros (`02134` → `2134`); other columns clean.
5. **type-mistakes-numbers-as-text.xlsx** — financial numbers stored as text with quote-prefix; ≥80% threshold trips.
6. **type-mistakes-date-serials.xlsx** — date column showing `45000` instead of `2023-03-15`; column header is "OrderDate".
7. **trailing-rows-footer.xlsx** — sheet with "Total" + "Generated 2024-01-15" + 3 blank rows at bottom (trips default threshold=3).
8. **header-row-3.xlsx** — report with "Quarterly Sales Report" in A1, blank row 2, headers in row 3.
9. **encoding-mojibake.xlsx** — synthetic mojibake cells (`Ã©` / `â€™` / `Ã±`) interspersed with clean UTF-8.
10. **dup-headers-csv-export.xlsx** — two `Email` columns + one `name` + one `Name` (case-insensitive collision).
11. **combined-grime.xlsx** — **NEW** — exercises detector-ordering invariants per SPEC §3.0: header on row 3, merged title above, NA variants in a numeric column, a trailing "Total" row, mojibake in a name column, and duplicate headers. Asserts ALL 7 detectors fire AND ordering is deterministic across 5 re-runs (golden fingerprint).
12. **na-variants-csv.csv** — **NEW** — covers the csv format scope. NA variants in a numeric column, multiple legitimate fields. Asserts: route returns 200; `merged_cell_residue` silently emits zero (csv has no merges); output is a single-sheet xlsx readable via xlsx_convert; finding count + types match golden.

Plus **clean-baseline.xlsx** — known-clean workbook used to assert zero false-positives across all 7 detectors.

**Fixture provenance rule:** all fixtures must be **synthetically generated** — no real customer data, no Bob's actual files. The grime patterns are reproduced; the data underneath is synthetic (names from a public test-data list; addresses from a fictional-city generator).

Bench runner: `~/xlsx-for-ai/data-cleaning-test-bench/run.js` — iterates fixtures, calls the live or local server, asserts:
- `findings` matches `expected.json` (order-insensitive; by type + location)
- `execute` mode produces a file matching `golden.xlsx` (canonical fingerprint)
- All findings carry the required shape per SPEC §2.3

Pass criteria: **10/10 fixtures pass**; CI fails if any regress.

## 5. Smoke test — CLI surface

`~/xlsx-for-ai/test/v2/clean-cli.test.js` (Node `node --test`):

- `xlsx-for-ai fixtures/na-variants-mixed/dirty.xlsx --clean` returns non-empty findings markdown
- `xlsx-for-ai fixtures/clean-baseline.xlsx --clean` returns `clean` verdict (zero findings)
- `xlsx-for-ai fixtures/na-variants-mixed/dirty.xlsx --clean --json` returns parseable JSON
- `xlsx-for-ai fixtures/na-variants-mixed/dirty.xlsx --clean --execute` writes a cleaned file to `<source>-cleaned.xlsx`
- Exits non-zero on file-not-found

## 6. Mocking strategy

- **No live API in unit tests** — detectors take parsed ExcelJS workbooks; tests construct workbooks in-memory via `new ExcelJS.Workbook()`.
- **No live API in integration tests** — Fastify route tests use Vitest + `app.inject()` against a test instance.
- **Bench tests** — run against either localhost server or live API based on `BENCH_TARGET` env (default `http://localhost:3000`).
- **CLI smoke** — runs against the test app, not the prod `api.xlsx-for-ai.dev` endpoint.

## 7. CI integration

Per `~/xlsx-for-ai-server/.github/workflows/`:
- Unit + integration tests run on every PR
- Bench corpus runs nightly + on tags
- Coverage gate: ≥90% on `src/lib/clean/*` (new code only)

Per `~/xlsx-for-ai/.github/workflows/`:
- CLI smoke runs on every PR
- Bench corpus consumed via the `data-cleaning-test-bench/run.js` smoke (one fixture, quick)

## 8. Privacy regression — automated check

Three assertions per fixture, run across the entire bench corpus:

**8.1 — Every `Finding.excerpt` matches the redaction contract.** Per SPEC §5, each excerpt is `[<type-token>: <safe-value>]` where `<safe-value>` is pattern-only, geometry-only, or a `hash:abcd1234` token. Test:

```typescript
const EXCERPT_RE = /^\[(na variant|merged region|type coercion|trailing row|header row|encoding glitch|duplicate header): [^\]]+\]$/;
const HASH_OR_PATTERN_RE = /^(hash:[0-9a-f]{8}|'[^']{1,12}'|matched '[^']{1,4}'|\d+×\d+ at [A-Z]+\d+:[A-Z]+\d+|rows \d+-\d+|row \d+|column [A-Z]+|\d+ cells)$/;

it('every Finding.excerpt matches the redaction contract', async () => {
  for (const fixture of benchFixtures) {
    const { findings } = await scan(fixture.dirty);
    for (const f of findings) {
      expect(f.excerpt).toMatch(EXCERPT_RE);
      const safeValue = f.excerpt.match(/^\[[^:]+: (.+)\]$/)[1];
      expect(safeValue).toMatch(HASH_OR_PATTERN_RE);
    }
  }
});
```

**8.2 — Cross-check `Finding.excerpt` against the source workbook's raw cell values.** Read every cell value from the source workbook; assert no substring of length ≥5 from any source cell appears verbatim in any `Finding.excerpt` (modulo the allowed pattern literals like `'N/A'`). Catches raw-content leakage that the regex alone might miss.

```typescript
it('no raw source-cell content leaks into any Finding.excerpt', async () => {
  for (const fixture of benchFixtures) {
    const sourceCells = extractAllCellValues(fixture.dirty);  // ExcelJS read; returns Set<string>
    const { findings } = await scan(fixture.dirty);
    for (const f of findings) {
      const safeValue = f.excerpt.match(/^\[[^:]+: (.+)\]$/)[1];
      for (const sourceValue of sourceCells) {
        if (sourceValue.length < 5) continue;  // short values may legitimately appear in patterns
        if (KNOWN_PATTERN_LITERALS.includes(sourceValue)) continue;  // 'N/A', '#N/A', etc.
        expect(safeValue).not.toContain(sourceValue);
      }
    }
  }
});
```

**8.3 — `receipt_markdown` contains nothing beyond the findings' excerpts + counts.** Assert that every alphabetic substring of length ≥10 in the receipt is either (a) a detector type-token name, (b) a sheet name from the source, (c) a hash prefix `hash:[0-9a-f]{8}`, or (d) one of the boilerplate phrases listed in the receipt template. No free-form raw content.

(Pass criteria: all three assertions pass across all 12 bench fixtures. Failure = privacy gate blocks the change-report.)

## 8.4 Detector ordering test — combined-grime fixture

Per SPEC §3.0, detectors run in a fixed order: header → dup-header → merged → trailing → type-coercion → na-variant → encoding-glitch. Assertion on the `combined-grime.xlsx` fixture:

```typescript
it('detector ordering is deterministic + matches the spec', async () => {
  const { findings, statistics } = await scan('combined-grime.xlsx');
  // Findings come back in detector-emission order (asserted by detector tokens):
  const seen = findings.map(f => f.type);
  const orderedDetectors = ['header_row_not_first', 'duplicate_header', 'merged_cell_residue',
                             'trailing_row_noise', 'type_coercion_mistake', 'na_variant', 'encoding_glitch'];
  // For each detector that fired, its first occurrence in `seen` must come before
  // the first occurrence of any later-ordered detector.
  for (let i = 0; i < orderedDetectors.length; i++) {
    for (let j = i + 1; j < orderedDetectors.length; j++) {
      const iIdx = seen.indexOf(orderedDetectors[i]);
      const jIdx = seen.indexOf(orderedDetectors[j]);
      if (iIdx >= 0 && jIdx >= 0) {
        expect(iIdx).toBeLessThan(jIdx);
      }
    }
  }
  expect(statistics.detectors_run).toEqual(orderedDetectors);  // all 7 fire
});
```

Also asserted: re-running on the same fixture 5× produces identical `findings` array ordering (no Set/Map iteration order leaking through).

## 8.5 Partial-execute failure-path test

Per SPEC §7: when `mode=execute` produces `applied_count < findings.length`, the response should populate `failed_count` + `skipped_count` correctly and `applied_error` per Finding.

```typescript
it('partial-execute reports per-finding failure reasons', async () => {
  // Use overrides to force a skip on one detector + scenario where transform fails.
  const result = await scan('combined-grime.xlsx', {
    mode: 'execute',
    overrides: [{ detector: 'na_variant', scope: { sheet: 'Sheet1' }, action: 'skip' }],
  });
  // Skipped findings carry applied=false + applied_error="override scope said skip":
  const skippedNa = result.findings.filter(f => f.type === 'na_variant');
  for (const f of skippedNa) {
    expect(f.applied).toBe(false);
    expect(f.applied_error).toContain('override scope said skip');
  }
  // Counts add up:
  expect(result.applied_count + result.failed_count + result.skipped_count)
    .toBe(result.findings.length);
  expect(result.skipped_count).toBe(skippedNa.length);
});
```

Also asserted: `reject_findings=[...]` produces `applied=false` with `applied_error="rejected via reject_findings"`.

## 9. Determinism test

```typescript
it('produces stable canonical fingerprint across 5 runs', async () => {
  const fingerprints = new Set();
  for (let i = 0; i < 5; i++) {
    const { output_file_handle } = await scan(fixture.dirty, { mode: 'execute' });
    const bytes = await cacheDownload(output_file_handle);
    fingerprints.add(canonicalFingerprint(bytes));
  }
  expect(fingerprints.size).toBe(1);
});
```

Run against all 10 bench fixtures.

## 10. Acceptance — when is testing "done"?

- 100% of unit tests pass
- 100% of integration tests pass
- 10/10 bench fixtures pass (findings + execute fingerprint)
- 100% of CLI smoke tests pass
- Privacy regression test passes (no raw content in receipts)
- Determinism test passes (5×fingerprint = 1 unique per fixture)
- ≥90% line coverage on `src/lib/clean/*`

Failing any gate blocks the change-report grace gate.

## 11. Test data sourcing — strictly synthetic

Per the standing rule on privacy + no real names: every bench fixture is built from public synthetic data:
- Names: from `faker-js` library output, seeded for determinism
- Addresses: fictional-city template ("Springfield", "Riverdale", etc.)
- Emails: `<faker-name>@example.test` (RFC-reserved domain)
- Phone numbers: `555-01XX` (RFC-reserved range)
- Companies: fictional ("Acme Corp", "Globex Industries", etc.)

No Bob's actual customer data, no Mailshake files, no Greenblatt / Finance / Books data. Mojibake fixtures synthesize the glitches by deliberately round-tripping known-good UTF-8 through CP1252 decode.

## 12. References

- SPEC: `SPEC.md` (sibling)
- Existing test patterns: `~/xlsx-for-ai-server/test/routes/xlsx-doctor.test.ts` (closest prior art)
- Bench prior art: `~/xlsx-for-ai/test/v2/` (CLI smoke patterns)
- Vitest config: `~/xlsx-for-ai-server/vitest.config.ts`
