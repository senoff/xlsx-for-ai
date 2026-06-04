# xlsx-for-ai — Data Cleaning Library · SPEC

*xlsx, 2026-05-27. v1.0 spec for the `xlsx_data_clean` tool + client surface.*

## 1. Overview

`xlsx_data_clean` is a hosted-API tool that scans a `.xlsx` workbook for common data-grime issues, returns a structured manifest of findings, and optionally executes a deterministic cleaning pass. The output is a normalized dataset ready for downstream AI consumption.

**Format scope at v1:**

- **`.xlsx` (primary)** — full detector + transform coverage.
- **`.csv` / `.tsv` (supported via parse-to-workbook)** — accepted on input; the upload pipeline parses to a single-sheet workbook before the cleaning pipeline runs. Detectors that depend on workbook-only concepts (`merged_cell_residue`) silently skip on csv/tsv inputs (their output simply contains no findings of that type). Output is written back as a single-sheet xlsx (caller can re-flatten via `xlsx_convert`).
- **`.xls` / `.ods` — DEFERRED to v1.1.** ExcelJS read paths for these formats are not in the current server's engine; adding them is a separate engine-seam task.

`xlsx_data_clean` returns `400 + unsupported_format` for any input outside `.xlsx` / `.csv` / `.tsv`.

**Informer, not enforcer:** default `mode=diagnose` returns findings only; `mode=execute` applies fixes deterministically. The tool never silently transforms data without the caller's opt-in.

**Distinct from `xlsx_doctor`:** doctor diagnoses structure-preservation concerns (macros / hidden sheets / external links); data-clean diagnoses data-quality concerns (NA variants / merged-cell residue / header inference / encoding glitches / type coercion / trailing-row noise / duplicate headers). The two are complementary — doctor is "should I share this," data-clean is "is this dataset ready for downstream consumption."

## 2. API surface

### 2.1 REST

```
POST /api/v1/tools/xlsx_data_clean
Authorization: Bearer <token>
Content-Type: application/json

{
  "file_handle": "string",                 // cache-uploaded file reference (per the existing /cache/upload-chunk + /cache/finalize flow used by all xlsx-* tools)
  "mode": "diagnose" | "execute",          // default "diagnose"
  "detectors": [                           // optional; defaults to all 7 — names match Finding.type tokens
    "na_variant",
    "merged_cell_residue",
    "type_coercion_mistake",
    "trailing_row_noise",
    "header_row_not_first",
    "encoding_glitch",
    "duplicate_header"
  ],
  "sheets": ["string"],                    // optional; sheet NAMES (not indices); defaults to all sheets. Unknown sheet name → 400 unknown_sheet
  "options": {                             // global option defaults
    "trailing_threshold": 3,               // # consecutive empty/non-data rows to flag (default 3; min 1, max 100)
    "header_scan_depth": 10,               // first N rows to consider when inferring header (default 10; min 2, max 50)
    "na_canonical": ""                     // canonical form for NA replacement: "" | "null" | "(blank)" (default "")
  },
  "overrides": [                           // optional per-column / per-region overrides (each item is fully scoped)
    {
      "detector": "na_variant",            // detector this override applies to (REQUIRED — one detector per override entry)
      "scope": {                           // EITHER sheet+column OR sheet+region; one scope per override
        "sheet": "string",                 // REQUIRED
        "column_letter": "B",              // OPTIONAL — A1-style column letter; per-column scope
        "region": { "top_left": "A1", "bottom_right": "C10" }  // OPTIONAL — rectangular region; cannot coexist with column_letter
      },
      "action": "skip" | "flag_only" | "force",  // skip = exclude this detector from the scope; flag_only = detect but never auto-apply; force = always apply when execute
      "params": {}                         // detector-specific param overrides; schema per detector — see §3
    }
  ],
  "accept_findings": ["string"],           // execute-mode only — finding IDs to apply (default: all findings)
  "reject_findings": ["string"]            // execute-mode only — finding IDs to skip (default: none)
}
```

**Validation rules:**
- `detectors` empty array → `400 + empty_detector_list`. Use omit-the-field to mean "default to all."
- Unknown detector token in `detectors` → `400 + unknown_detector`.
- `accept_findings` + `reject_findings` overlapping → `400 + conflicting_finding_selection`.
- Both `accept_findings` and `reject_findings` provided → `400 + conflicting_finding_selection` (use one).
- `overrides[].scope` missing both `column_letter` and `region` → applies to the whole sheet for that detector.
- `overrides[].scope` with both `column_letter` and `region` → `400 + ambiguous_override_scope`.
- `mode=diagnose` with `accept_findings` / `reject_findings` set → silently ignored (diagnose never executes).

### 2.2 Response shape

```typescript
{
  tool: "xlsx_data_clean",
  verdict: "clean" | "has_findings",
  one_line_summary: string,            // "Found 12 data-grime issues across 2 sheets" / "Nothing notable found"
  findings: Finding[],
  findings_count_by_type: Record<string, number>,   // type token → count of Findings of that type
  applied_count: number,               // present only when mode=execute; = count of findings with applied=true
  failed_count: number,                // present only when mode=execute; = count of findings with applied=false AND applied_error set
  skipped_count: number,               // present only when mode=execute; = count of findings rejected via reject_findings / non-execute action
  output_file_handle: string | null,   // mode=execute: cache reference to cleaned file. null when applied_count === 0 (no changes ⇒ no output). always null in diagnose mode.
  receipt_markdown: string,            // human-readable per-finding receipt
  manifest_metadata: {                 // structured audit data the receipt summarizes
    merge_regions_flattened: Array<{ sheet: string, original: { top_left: string, bottom_right: string }, fill_value_kind: "first_cell" }>,
    header_lifts: Array<{ sheet: string, lifted_from_row: number, preamble_rows_preserved: number }>,
    trailing_rows_truncated: Array<{ sheet: string, truncated_from_row: number, original_last_row: number }>,
    encoding_recodes: Array<{ sheet: string, cell_count: number, source_encoding: "cp1252", target_encoding: "utf-8" }>,
    duplicate_header_renames: Array<{ sheet: string, from: string, to: string }>,
    detector_skips: Array<{ detector: string, sheet: string, reason: string }>   // detectors that crashed or were skipped per §7
  },
  statistics: {
    sheets_scanned: number,
    rows_scanned: number,              // sum of rows across scanned sheets (post-trim if execute mode; pre-trim if diagnose)
    cols_scanned: number,              // sum of max-col across scanned sheets
    duration_ms: number,
    peak_rss_mb: number,               // server-side memory ceiling observed during this scan
    detectors_run: string[]            // the actual detector tokens that ran (echoes the request after defaulting)
  }
}
```

**`output_file_handle` invariants:**
- `mode=diagnose` → always `null`. Input is never mutated; the cache entry's bytes are byte-equal before and after.
- `mode=execute` with `applied_count === 0` → `null`. No output is generated when nothing was applied.
- `mode=execute` with `applied_count > 0` → a fresh cache handle. The cleaned file is readable via `/cache/download`.

**`findings_count_by_type` invariants:**
- Keys are the seven detector tokens (`na_variant`, `merged_cell_residue`, ...).
- `sum(values) === findings.length`.
- Detectors absent from the request's `detectors` array do NOT appear as keys.

### 2.3 Finding shape

```typescript
{
  id: string,                              // stable per-scan ID — `<type>:<sheet>:<location-fingerprint>`; usable in accept_findings / reject_findings
  type: "na_variant" | "merged_cell_residue" | "type_coercion_mistake" | "trailing_row_noise" | "header_row_not_first" | "encoding_glitch" | "duplicate_header",
  severity: "high" | "medium" | "low",
  location: FindingLocation,               // shape depends on type — see invariants below
  excerpt: string,                         // redacted human-readable preview — always in `[<type-token>: '<redacted-value>']` form. The redacted value is hashed (first 8 chars of SHA-256) for cell-content values; the type-token names the detector.
  suggested_fix: {
    op: string,                            // one of the ops enumerated per detector in §3
    params: object                         // op-specific params (deterministic) — schema defined per op
  },
  applied: boolean,                        // execute mode: true when fix succeeded. diagnose mode: always false.
  applied_error: string | null             // execute mode + applied=false: human-readable reason ("override scope said skip", "transform failed: <reason>", "rejected via reject_findings"). diagnose mode + applied=false: null.
}
```

**`Finding.location` invariants per type:**

| `type` | `sheet` | `cell_ref` | `row_range` | `col_range` | Notes |
|---|---|---|---|---|---|
| `na_variant` | required | required | absent | absent | One Finding per matching cell. |
| `merged_cell_residue` | required | absent | required | required | The merged region's bounding box. |
| `type_coercion_mistake` | required | absent | absent | required (single-column) | Column-scope; per-column rather than per-cell to keep finding count proportional. |
| `trailing_row_noise` | required | absent | required | absent | The contiguous trailing run. |
| `header_row_not_first` | required | absent | required (single row) | absent | The inferred header row's position before lifting. |
| `encoding_glitch` | required | required | absent | absent | One Finding per matching cell. |
| `duplicate_header` | required | required | absent | required (single-column) | The duplicate column's header cell. |

Fields marked "absent" MUST NOT be present in the JSON object (not just `null`). Tooling can assert presence/absence to route findings safely.

**`Finding.id` construction** (stable across re-runs of the same input + options):
- `<type>:<sheet>:<col_letter>:<row>` for cell-scoped types (`na_variant`, `encoding_glitch`, `duplicate_header`)
- `<type>:<sheet>:<col_letter>` for column-scoped types (`type_coercion_mistake`)
- `<type>:<sheet>:<row_start>-<row_end>` for row-range types (`trailing_row_noise`, `header_row_not_first`)
- `<type>:<sheet>:<top_left>-<bottom_right>` for region types (`merged_cell_residue`)

IDs are stable across `mode=diagnose` and `mode=execute` runs on the same input. Clients can `mode=diagnose` first, then re-call `mode=execute` with `accept_findings` set to the subset they approved.

### 2.4 CLI surface (xlsx-for-ai npm package)

```
xlsx-for-ai <file> --clean                       # diagnose mode; prints findings markdown
xlsx-for-ai <file> --clean --execute             # execute mode; writes cleaned file alongside source
xlsx-for-ai <file> --clean --json                # raw JSON output
xlsx-for-ai <file> --clean --sheet <NAME>        # restrict to one sheet by NAME (not index)
xlsx-for-ai <file> --clean --sheet <N1>,<N2>     # multiple sheet names (comma-separated)
xlsx-for-ai <file> --clean --detectors <list>    # comma-separated detector tokens; default = all
```

**Sheet selector contract — same across API + CLI:** sheet NAME (not 1-based index). The CLI does not accept numeric sheet indices to avoid a divergence with the API. Unknown sheet name → exit 2 with `unknown_sheet: <name>` printed to stderr.

### 2.5 MCP surface

Tool name: `xlsx_data_clean`. Same input/output shape as REST. Available via the `xlsx-for-ai-mcp` MCP server.

## 3. Detectors (v1 — seven types)

### 3.0 Detector execution order + tie-breakers

Diagnose mode runs detectors in this fixed order; this matters for `findings_count_by_type` reproducibility and for execute-mode ordering (since some transforms change the cell coordinate space that later detectors read):

1. `header_row_not_first` — runs FIRST in diagnose because subsequent detectors need to know which row is the header (affects what counts as a "data" row for trailing-row noise and what counts as a "header cell" for duplicate-header).
2. `duplicate_header` — runs against the inferred header row from #1 (or row 1 if no lift was inferred).
3. `merged_cell_residue` — runs against the post-header-lift coordinate space (in diagnose, the coordinates report the pre-lift positions; in execute, the post-lift positions because the transform pass applies #1 before #3).
4. `trailing_row_noise` — runs against the inferred data region (rows after header through the last non-trailing data row).
5. `type_coercion_mistake` — runs per-column against the inferred data region.
6. `na_variant` — runs per-cell against the inferred data region.
7. `encoding_glitch` — runs per-cell against the inferred data region; LAST because it's the most expensive (per-cell substring scan).

**Execute-mode ordering** applies the same sequence as transforms, in the same order. Transforms that move cells (header-lift, trailing-truncate, merged-flatten) update the working sheet's coordinate space; subsequent transforms see the updated coordinates. The `Finding.location` fields in the response always report **pre-transform** coordinates so the receipt is reproducible from the input.

**Tie-breakers when two detectors target the same cell:**
- `merged_cell_residue` + `na_variant` overlap → merged wins (flatten first; the now-individual cells get NA-variant detection in the same diagnose pass, with the post-flatten values used).
- `type_coercion_mistake` + `na_variant` overlap on the same column → both fire; NA replacement happens before coercion (NA-replacement results never carry into coercion's "looks numeric" sample).
- `encoding_glitch` + any other detector on the same cell → both fire; encoding recode happens before the other transform in execute mode.


### 3.1 `na_variant` — NA variant normalization

**Detects:** cells whose value matches any of: `N/A`, `NA`, `n/a`, `-`, `null`, `NULL`, `None`, `nil`, `?`, `unknown`, Excel `#N/A` error, `--`. Also single-period `.` but ONLY when the cell is in a **numeric-context column** (see invariant below).

**Numeric-context column invariant:** a column is "numeric-context" when ≥60% of the column's non-empty values (excluding the header row, post-header-lift coordinates) parse as numeric per JavaScript `Number()` (excluding `NaN`/`Infinity`). The 60% threshold is fixed at v1; tune via aggregate signals post-launch if it proves wrong.

**Severity:** low.

**Suggested fix:** `replace_with_canonical_na` — replace with the value of `options.na_canonical` (default empty string). Per-cell; the canonical form is workbook-wide unless overridden per column via `overrides[]` with `detector: "na_variant"` + `scope.column_letter` + `params.canonical: "..."`.

**`suggested_fix.params` schema:**
```typescript
{ canonical: "" | "null" | "(blank)" | string }  // arbitrary string allowed via per-column override
```

**Edge case:** cells where the value is legitimately the string `"N/A"` (e.g. a survey response column). Detector flags; user opts out via `overrides[].action: "skip"` scoped to that column, OR via `accept_findings` / `reject_findings` in the execute call.

### 3.2 `merged_cell_residue` — flatten merged cells

**Detects:** any merged-cell region with ≥2 cells. ExcelJS exposes via `worksheet.model.merges` (array of A1-style range strings, e.g. `["A1:C1", "B5:B8"]`).

**Severity:** medium.

**Suggested fix:** `flatten_merged` — unmerge the region; forward-fill the merged value (the top-left cell's value) into the now-individual cells. Original merge geometry recorded in `manifest_metadata.merge_regions_flattened`.

**`suggested_fix.params` schema:**
```typescript
{
  region: { top_left: string, bottom_right: string },  // A1-style refs (e.g. "A1", "C1")
  fill_value_kind: "first_cell"                        // v1 only supports first-cell-value forward-fill
}
```

**Edge case:** styled merged regions (e.g. centered header banners). Detector flags by default; user opts out per region via `overrides[].action: "skip"` with `scope.region` matching the merge bounds.

### 3.3 `type_coercion_mistake` — type/format mismatch

Three sub-shapes, each with explicit thresholds. Detector runs per-column on the inferred data region (post-header-lift, pre-trailing-truncate). A column is flagged for at most one sub-shape (the first that matches in the order below); subsequent matches do not stack.

**Sub-shape A — Numeric stored as text:**
- Trigger: ≥80% of non-empty cells in the column have ExcelJS cell type `s` (shared-string) or `inlineStr`, AND each of those values matches `^-?\d{1,15}(\.\d+)?$` (no scientific notation; max 15-digit integer part to avoid silent precision loss on coerce).
- Suggested fix: `coerce_to_number`.
- `params` schema: `{ kind: "numeric_as_text", from_type: "string", to_type: "number", sample_count: number }` (sample_count = how many cells will be coerced).

**Sub-shape B — Date serial without date format:**
- Trigger: ≥80% of non-empty cells in the column have ExcelJS cell type `n` (numeric), values fall within `[25569, 73415]` (1970-01-01 through 2100-12-31 as Excel serial dates), AND the column's header cell text matches the regex `/(date|day|time|dt|when|created|modified|posted|due|expir|birth|dob|ts)/i` (case-insensitive).
- Suggested fix: `coerce_to_date`.
- `params` schema: `{ kind: "date_serial", from_type: "number", to_type: "date", target_format: "yyyy-mm-dd", sample_count: number }`.

**Sub-shape C — Leading zero stripped from identifier:**
- Trigger: ≥80% of non-empty cells in the column are ExcelJS cell type `n` (numeric), the column's header text matches `/(zip|postal|postcode|phone|tel|ssn|tin|ein|fips|code|id|account|invoice)/i`, AND ≥30% of the column's values have a digit count strictly less than the column's mode-of-digit-count (i.e. a clear "shorter than typical" tail consistent with dropped leading zeros).
- Suggested fix: `preserve_as_text_with_leading_zero`.
- `params` schema: `{ kind: "leading_zero_stripped", from_type: "number", to_type: "string", target_digit_count: number, sample_count: number }` (target_digit_count = the column's mode-of-digit-count to pad to).

**Severity:** medium across all three sub-shapes.

**Non-silent contract:** `type_coercion_mistake` is always emitted as a Finding — diagnose and execute mode alike — so the receipt carries the sub-shape + sample_count. The agent layer (`cleaner`) walks each Finding with proceed/modify/skip per `[[feedback-informer-not-enforcer]]`; the library itself never auto-applies based on confidence. Library `mode=execute` only applies findings explicitly listed in `accept_findings` (or, in the no-`accept_findings` default, applies all findings the agent has not explicitly rejected — the agent's responsibility to filter at the agent layer).

**Sub-shape C extra emphasis** — leading-zero-stripped is the most-likely-wrong heuristic of the three; per SPM 2026-05-27 review, ALWAYS surfaces with asks-and-shows confirmation before applying (the agent layer enforces this; library does not auto-apply for sub-shape C regardless of the threshold).

**Mixed-type columns:** if the 80% threshold fails on all three sub-shapes, NO finding is emitted (mixed content is signal, not noise; transformation could be destructive).

### 3.4 `trailing_row_noise` — trailing-row detection

**Detects:** A contiguous run of "noise rows" at the bottom of a sheet. A row is a "noise row" when AT LEAST ONE of:
- All cells in the row are empty (zero non-empty cells across the sheet's used column range);
- Exactly one non-empty cell whose text matches `/^(total|grand total|subtotal|summary|footer|notes:|footnote|—.*—|\*.*\*|generated.*|prepared by|signature.*|page \d+|©.*|copyright.*)$/i` (case-insensitive, after `.trim()`);
- All non-empty cells in the row are exclusively in a "label" column (column A or column 1) AND none of the row's values are numeric.

**Trigger:** the bottom-most ≥`options.trailing_threshold` (default 3, min 1, max 100) rows are all noise rows AND are not preceded by a data row within the same noise run. Trailing run starts at the first noise row after the last data row.

**Severity:** low.

**Suggested fix:** `truncate_to_data` — set the sheet's used range to end at the last data row. Original trailing rows captured in `manifest_metadata.trailing_rows_truncated`.

**`suggested_fix.params` schema:**
```typescript
{
  truncate_from_row: number,   // 1-based row where truncation starts (first noise row)
  original_last_row: number    // 1-based row of the sheet's pre-truncate last row
}
```

### 3.5 `header_row_not_first` — header inference

**Detects:** workbooks where the most-likely header row is NOT row 1. Scans rows 1 through `options.header_scan_depth` (default 10, min 2, max 50); scores each candidate row; emits a finding only when the winning row's score exceeds row 1's score by the score margin below.

**Per-row score (higher = more header-like):**
- +3 if all non-empty cells in the row are strings (cell type `s` / `inlineStr`).
- +2 if the row's non-empty-cell count exceeds the median non-empty-cell count across rows 1..`header_scan_depth` (i.e. the row spans more columns than typical).
- +2 if ≥50% of the row's cells are unique values within the row (header rows rarely repeat).
- +1 if at least one cell matches a common header-token pattern: `/^(id|name|date|email|phone|amount|total|status|type|qty|quantity|description|customer|product|sku|address)$/i`.
- -3 if any cell in the row is numeric and the column below it (rows below this candidate) is also numeric for ≥80% of cells (suggests the candidate is a data row, not a header).
- -2 if the row has fewer than 2 non-empty cells (titles/preambles score low).

**Score margin trigger:** `winning_row.score >= row_1.score + 3` AND `winning_row.score >= 5`. Both required; the +3 margin prevents tie-flips and the absolute floor prevents false positives in workbooks where row 1 IS the header but only weakly.

**Multi-row header note:** v1 does NOT auto-detect multi-row headers (rows 1+2 both header-y) — these score similarly and the +3 margin keeps the detector silent. v1.1 may add explicit multi-row header support.

**Severity:** high.

**Suggested fix:** `lift_header_to_row_1` — drop rows 1 through `winning_row - 1`; the winning row becomes row 1. Original preamble rows captured in `manifest_metadata.header_lifts[].preamble_rows_preserved` (count only; preamble content is NOT echoed in the response for privacy).

**`suggested_fix.params` schema:**
```typescript
{
  lifted_from_row: number,           // 1-based row in the source that becomes row 1 after lift
  preamble_rows_to_drop: number,     // = lifted_from_row - 1
  confidence_score: number,          // the winning row's score (debug aid)
  margin_over_row_1: number          // = winning_row.score - row_1.score (debug aid)
}
```

### 3.6 `encoding_glitch` — mojibake detection

**Detects:** cells whose text contains any byte sequence that matches a known UTF-8-as-CP1252 mojibake pattern. The detection pattern set (regex union, case-sensitive):

```
â€™ | â€œ | â€ | â€" | â€- | Ã© | Ã  | Ã¨ | Ã¡ | Ã­ | Ã³ | Ãº | Ã± | Ã– | Ã‰ | Â | Â£ | Â© | Â® | ï»¿
```

**Confidence:** detection is regex-only; transform only applies the cp1252→utf8 round-trip IF the transformed text would be a valid UTF-8 string with at least one of the above patterns successfully resolved (i.e. transform is conservative: never silently mangles a cell whose mojibake was a one-off coincidence).

**Severity:** medium.

**Suggested fix:** `recode_from_cp1252_to_utf8` — re-encode the cell value through the cp1252→utf8 round-trip. Only affects the flagged cell; clean UTF-8 cells in the workbook are untouched.

**`suggested_fix.params` schema:**
```typescript
{
  cell_ref: string,               // A1-style cell ref (matches Finding.location.cell_ref)
  source_encoding: "cp1252",
  target_encoding: "utf-8",
  matched_patterns: string[]      // which mojibake bigrams matched (debug + audit)
}
```

### 3.7 `duplicate_header` — disambiguate duplicate column headers

**Detects:** the header row (post-header-lift, see §3.0 ordering) contains ≥2 cells whose values are identical after `.trim().toLowerCase()` normalization. Empty header cells (after trim) are NOT flagged (they're a different concern — `missing_header` — out of v1 scope).

**Severity:** medium.

**Suggested fix:** `disambiguate_with_suffix` — keep the FIRST occurrence as-is (preserving the original casing); append `_2`, `_3`, ... to subsequent occurrences in left-to-right column order. The suffix counter is per-(normalized-base-name); two distinct base names colliding produce two independent counters. Renames recorded in `manifest_metadata.duplicate_header_renames`.

**Case-handling:** suffix is appended to the cell's original casing. So `Name` (col A) + `name` (col D) → A stays `Name`, D becomes `name_2` (preserves user's casing intent per-cell).

**`suggested_fix.params` schema:**
```typescript
{
  base_name: string,             // the normalized base (lowercased) used for counter grouping
  occurrence_index: number,      // 1-based: 1 = first, 2 = second, etc.
  from: string,                  // original cell value (e.g. "name")
  to: string                     // post-rename value (e.g. "name_2"); only set when occurrence_index >= 2
}
```

Only `occurrence_index >= 2` rows produce a Finding (the first occurrence is the canonical one — nothing to rename).

## 4. Determinism contract

**Same input + same `options` + same `mode=execute` → semantically-identical output** with a stable canonical fingerprint (sorted-attribute XML canonicalization + per-sheet SHA-256).

Caveat (lifted verbatim from the Prep spec review): bitwise determinism across ExcelJS versions is not guaranteed; the canonical fingerprint IS guaranteed.

All detectors are pure functions of the input bytes + the options. No external state, no LLM calls. The tool is fully testable + reproducible.

## 5. Privacy + redaction

**Excerpt redaction contract (binds every `Finding.excerpt` and every line in `receipt_markdown`):**

Every excerpt MUST be in the form `[<type-token>: <safe-value>]` where:

- `<type-token>` is one of: `na variant`, `merged region`, `type coercion`, `trailing row`, `header row`, `encoding glitch`, `duplicate header` — matching the Finding.type.
- `<safe-value>` is one of:
  - **Pattern-only excerpts** (no raw cell content): `'N/A'`, `'NA'`, `'#N/A'`, etc. for `na_variant` — the matched literal IS the pattern, not user data. Allowed verbatim.
  - **Geometry-only excerpts** (no raw cell content): `'3×2 at A1:C2'` for `merged_cell_residue`, `'rows 14-18'` for `trailing_row_noise`, `'row 3'` for `header_row_not_first`. Allowed verbatim.
  - **Hash excerpts** (when the value carries user data): `'<hash:abc12345>'` — the first 8 hex chars of SHA-256(value), prefixed with `hash:`. Used for `encoding_glitch` (the user's cell content might be a name/address), `duplicate_header` (the user's column name), and `type_coercion_mistake` (sample cell value).

**Encoding-glitch carve-out:** for `encoding_glitch` findings, the matched mojibake bigram itself MAY be quoted in the excerpt (it IS the pattern). The surrounding user-data context is NOT quoted. Example: `[encoding glitch: matched 'â€™' (hash:abc12345)]` — the bigram is the pattern; the hash is the cell value.

**Receipt redaction contract:** `receipt_markdown` is built by concatenating `Finding.excerpt` strings (with detector group headers and counts). It carries NO content beyond what's in the findings array's excerpts. Asserted in the privacy regression test (TEST_PLAN §8).

**`output_file_handle` (execute mode):**
- The cleaned file IS the cleaned user data — full content. Lives in the cache layer with the same retention / privacy posture as other tools (per `~/xlsx-for-ai-server/src/lib/hardening/`).
- Distinct from `Finding.excerpt`: the file output is the user's data (legitimate); the excerpts are diagnostic metadata (must be redacted).

**Telemetry:**
- No raw cell content in any telemetry span / log line / metric label.
- Eligible aggregate signals: finding-type counts, accept/reject rates per detector, format distribution, duration percentiles. Tracked at the workbook level — never at cell-level.

## 6. Performance gates

- **Diagnose mode:** sub-3-second on typical files (1-10 sheets, <100K rows total).
- **Execute mode:** sub-10-second on typical files; sub-30-second on heavy files (10+ sheets, 100K-1M rows).
- **Memory:** ≤500MB on files up to 50MB (matches existing xlsx-doctor budget).
- **Streaming I/O:** ExcelJS `WorkbookReader` (read-only streaming) where the detector permits; full-load fallback for cross-row detectors (header inference, trailing-row noise) with bounded look-back buffer.

## 7. Error handling

| Failure | Response |
|---|---|
| File-not-found or expired cache handle | `404` + `{"error": "file_not_found"}` |
| File too large (>50MB) | `413` + `{"error": "file_too_large"}` |
| File is not a valid xlsx/csv/tsv/xls/ods | `400` + `{"error": "unsupported_format"}` |
| Detector crashes on one sheet | log + skip; surface in receipt as `"detector_skipped: <type> on <sheet>: <reason>"` |
| Execute mode partial-success | return success with `applied_count < findings.length`; receipt lists per-finding `applied: false` reasons |

## 8. Acceptance criteria

### 8.1 Functional gates

- 7/7 detectors emit findings on the targeted bench fixtures.
- 7/7 transforms apply deterministically on the same fixtures.
- Zero detector false-positives on a known-clean baseline fixture.
- `mode=diagnose` never mutates the input file (verified by output handle being absent + byte-equality of input cache entry).
- `mode=execute` produces a cleaned file readable by ExcelJS, openpyxl, and the existing `xlsx_convert` tool.

### 8.2 Performance gates

- Diagnose mode <3s on the 10-fixture bench corpus.
- Execute mode <10s on the same corpus.
- Memory ceiling: peak RSS ≤500MB on a 50MB synthetic file.

### 8.3 Privacy gates

- No raw cell content in any finding's excerpt (verified by regex scan of receipt output across the bench corpus).
- Cleaned output file does NOT include source filename or path in any embedded metadata.

### 8.4 Determinism gate

- Same fixture + same options + `mode=execute` × 5 runs → same canonical fingerprint (SHA-256 of canonicalized per-sheet XML).

### 8.5 Integration gates

- New tool registered in `src/routes/tools-list.ts`.
- npm package `--clean` flag wires correctly (smoke test in `test/v2/`).
- MCP tool callable from a fresh Claude Code session (manual smoke; agent test as part of `cleaner` agent build).

## 9. Out of scope at v1

- Semantic / fuzzy dedup (lives in Prep)
- Domain-specific transforms — CRM canonicalization, GL subtotal stripping, etc. (lives in Prep)
- PII redaction (lives in PII Frisk + server's existing PII pipeline)
- Formula-error propagation (lives in Healer)
- Cross-sheet consistency checks
- Multi-source merge (lives in Prep)

## 10. Dependencies

**Server-side (xlsx-for-ai-server):**
- `@protobi/exceljs` ≥4.4.0 (already a dep)
- `fastify` ≥5.3 (already a dep)
- No new external deps required for v1 detectors

**Client-side (xlsx-for-ai npm package):**
- No new deps; `lib/clean.js` is a thin wrapper around the existing `callTool` helper

## 11. Versioning

- xlsx-for-ai npm package: minor bump 2.23.0 → 2.24.0 on landing
- xlsx-for-ai-server: minor bump 2.0.0 → 2.1.0 on landing (v1 of the data-clean capability)
- MCP tool name: `xlsx_data_clean` (stable contract; future tool versions ship as new names if breaking)

## 12. References

- Existing tool prior art: `~/xlsx-for-ai-server/src/routes/xlsx-doctor.ts`
- Cache upload flow: `~/xlsx-for-ai-server/src/routes/cache-upload-chunk.ts` + `cache-finalize.ts`
- Hardening posture (for detector defensive wrapping): `~/xlsx-for-ai-server/src/lib/hardening/index.ts`
- Telemetry policy: `~/xlsx-for-ai/docs/` (telemetry design notes)
- The agent that ships this: `agent/SPEC.md` (sibling)
