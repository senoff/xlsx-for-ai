# xlsx-for-ai

> 👋 **New here? Not a programmer?** → [Read WHY.md for the plain-English version](WHY.md). The README below is the technical reference.

**The bidirectional bridge between spreadsheets and AI agents.** Reads `.xlsx` (plus `.csv`, `.tsv`) into the formats LLMs actually consume — markdown, JSON, text, SQL — and writes spreadsheets back out from AI-generated specs. Same tool, both directions.

AI tools — Claude, Cursor, Copilot, ChatGPT, and other LLM coding agents — can read text files but **not** `.xlsx` binaries. This CLI closes the loop:

**📖 Read mode (default)** — turn any spreadsheet into LLM-readable output. Every formula, every named range, every merged cell, every fill color, every cross-sheet reference. No more pasting numbers and losing context.

**✍️ Write mode (`xlsx-for-ai write`)** — turn an AI-generated JSON or markdown spec into a real `.xlsx` file. Closes the round-trip so an agent that *reviews* your spreadsheet can also *deliver the corrected file*. The output includes a `_xlsx-for-ai` review tab explaining every structural change the round-trip made (with risks, tradeoffs, and overrides) — the supervisor model: AI does the work, the human stays in control of every decision. Verified lossless on 29/30 real workbooks.

**Input formats:** `.xlsx` `.csv` `.tsv` (legacy `.xls` / `.xlsb` / `.ods` removed in 1.5.4 — convert to `.xlsx` first; see [#26](https://github.com/senoff/xlsx-for-ai/issues/26))

**Output modes:** text dump, markdown tables (best LLM comprehension per token), JSON, SQL `CREATE TABLE`+`INSERT`, inferred schema, workbook diff, real `.xlsx` (write mode).

It extracts everything a human would see in Excel:

- **Values** — strings, numbers, dates
- **Formulas** — the actual formula expression, plus shared-formula references
- **Formatting** — bold, italic, font colors, background fills
- **Number formats** — percentages, currency, custom patterns
- **Layout** — column widths, frozen panes, merged cells, alignment
- **Hyperlinks** — URLs embedded in cells
- **Comments / notes** — cell annotations
- **Named ranges** — workbook-defined names and their references
- **Hidden rows & columns** — flagged so the AI knows data is suppressed
- **Data validation** — dropdown lists, numeric constraints
- **Tables** — Excel Table objects with their names and column headers
- **Images & charts** — existence and position noted (content not rendered)
- **Auto-filters** — active filter ranges
- **Print areas** — defined print regions

> Previously published as **`cursor-reads-xlsx`**. The old name still works as an alias on the CLI, but please install the new package: `npm install -g xlsx-for-ai`.

## Install

```bash
npm install -g xlsx-for-ai
```

Or run directly with npx (no install needed):

```bash
npx xlsx-for-ai budget.xlsx
```

## Usage

```bash
# Dump all sheets
npx xlsx-for-ai data.xlsx

# Dump a specific sheet
npx xlsx-for-ai data.xlsx "Sheet1"

# List sheet names and dimensions without dumping
npx xlsx-for-ai data.xlsx --list-sheets

# Print to stdout instead of writing files
npx xlsx-for-ai data.xlsx --stdout

# Limit to first 200 rows per sheet (useful for huge files)
npx xlsx-for-ai data.xlsx --max-rows 200

# Limit to first 8 columns (useful for very wide sheets)
npx xlsx-for-ai data.xlsx --max-cols 8

# Suppress noisy default tags (default text colors, white fills, etc.)
npx xlsx-for-ai data.xlsx --stdout --compact

# Emit structured JSON (one entry per cell) instead of the text dump
npx xlsx-for-ai data.xlsx --json --stdout > out.json

# Combine flags
npx xlsx-for-ai data.xlsx "Sheet1" --stdout --max-rows 50 --compact
```

### Options

**Output modes** (mutually exclusive; default = text):

| Flag | Description |
|------|-------------|
| `--md` | Markdown tables — highest LLM comprehension per token |
| `--json` | Structured JSON, one object per cell |
| `--sql` | `CREATE TABLE` + `INSERT` statements (uses inferred schema) |
| `--schema` | Per-column schema (name, type, nullable, samples) as JSON |

**Selection:**

| Flag | Description |
|------|-------------|
| `[sheetName]` | Positional: dump only this sheet |
| `--range A1:D50` | Dump only this rectangular range |
| `--named-range NAME` | Dump only the cells covered by a workbook-defined name |
| `--region` | Auto-detect the dominant contiguous data block (Excel "current region" / Ctrl+Shift+*). Picks the largest region by populated-cell count when multiple disjoint blocks exist. Compatible with `--max-rows` / `--max-cols`. |
| `--max-rows N` | Cap at the first N rows per sheet |
| `--max-cols N` | Cap at the first N columns per sheet |

**Output control:**

| Flag | Description |
|------|-------------|
| `--list-sheets` | Print sheet names + dimensions and exit |
| `--stdout` | Print to stdout instead of writing files in `.xlsx-read/` |
| `--compact` | Suppress noisy default tags (default colors, "General" format) |
| `--max-tokens N` | Truncate output to ~N tokens; appends a tail summary noting what was dropped |
| `--evaluate` | Promote cached formula results to primary value; re-evaluate simple formulas via formulajs |

**Other modes:**

| Flag | Description |
|------|-------------|
| `--diff OTHER` | Diff this workbook vs `OTHER` — emit changed/added/removed cells and sheets |
| `--stream` | Streaming reader for huge `.xlsx` files (>100MB); emits row-by-row, drops some sheet metadata |
| `-h`, `--help` | Show help |

### Write mode (`xlsx-for-ai write`)

The `write` sub-command produces a real `.xlsx` from a JSON or markdown spec.

```bash
xlsx-for-ai write spec.json                    # → spec.xlsx
xlsx-for-ai write spec.json -o report.xlsx     # explicit output
xlsx-for-ai write report.md                    # markdown table → xlsx
cat spec.json | xlsx-for-ai write -            # stdin
```

Minimum JSON spec:

```json
{
  "name": "Budget",
  "headers": ["Category", "Q1", "Q2"],
  "rows": [
    ["Marketing", 10000, 12000],
    ["R&D", 50000, 55000]
  ]
}
```

Multi-sheet, with formulas:

```json
{
  "sheets": [
    {
      "name": "Summary",
      "headers": ["Region", "Revenue", "Cost", "Profit"],
      "rows": [
        ["North", 100, 60, {"formula": "=B2-C2"}],
        ["South", 200, 110, {"formula": "=B3-C3"}]
      ],
      "frozen": {"rowSplit": 1, "colSplit": 0}
    },
    {
      "name": "Detail",
      "headers": ["SKU", "Qty"],
      "rows": [["A", 10], ["B", 20]]
    }
  ],
  "namedRanges": {"Profits": "Summary!D2:D3"}
}
```

**Round-trip:** the output of `xlsx-for-ai data.xlsx --json` is a valid input to `xlsx-for-ai write`, so reading then re-writing reproduces the file (verified on 29/30 real workbooks; the one MINOR is a CRLF→LF normalization in shared strings — visible content is identical).

**Markdown spec:** one or more tables; `## Sheet Name` headings split into multiple sheets. Backtick-fenced cells become formulas (e.g., `` `=A1+B1` ``). Numbers, booleans, and ISO dates auto-detect.

**v1 limitations:** edit-in-place (deferred to v1.5), charts, pivot tables, conditional formatting, images, macros — none of these are written. Shared formulas degrade to their cached values (formula link is lost; computed value is preserved).

#### The `_xlsx-for-ai` review tab

When the round-trip introduces any lossy structural changes (shared-formula degradation, line-ending normalization, etc.), `xlsx-for-ai write` adds a `_xlsx-for-ai` sheet to the output as the last tab. It's a **review note**, not just a warning list — for each issue type it explains:

- **What happened** — the source structure that couldn't be preserved
- **What we did** — the choice the tool made
- **Risk** — what could go wrong (e.g., *"if you edit cells the formula depended on, they won't recalculate"*)
- **Tradeoff** — what's worse about this choice vs. alternatives
- **Alternative** — exactly what flag/source change to apply if you want different behavior
- **Affected cells** — the specific refs, plus a full detail table at the bottom

The point: the user (or an AI agent reading the file) can understand every decision the tool made and override any of them. Same shape as a code reviewer's PR comment — observation + reasoning + alternative.

`--no-report` suppresses the tab if you want byte-clean output (useful for CI / round-trip tests). The `--diff` mode also ignores the `_xlsx-for-ai` tab automatically so it doesn't pollute change reports.

Output files are written to `.xlsx-read/` in the current working directory.
The path(s) are printed to stdout so your agent knows where to read.

## Output Format

### Text dump (default)

```
=== Sheet: Sales ===
Frozen: row 1, col 0
Columns: A(12) B(20) C(15) D(10)
Auto-filter: A1:D20
Named ranges:
  Totals: Sales!$D$2:$D$20
Table: "SalesTable" A1:D20 — columns: Region, Q1, Q2, Total

--- Row 1 [bold] ---
  A1: "Region"  [bold]
  B1: "Q1"  [bold] [align:center]
  C1: "Q2"  [bold] [align:center]
  D1: "Total"  [bold] [align:center]
--- Row 2 ---
  A2: "North"  [link: https://example.com/north]
  B2: 14500  [numFmt: #,##0]
  C2: 17200  [numFmt: #,##0]
  D2: 31700  [formula: =B2+C2] [numFmt: #,##0] [note: Includes returns]
--- Row 3 ---
  A3: "South"  [fill:FFFFFF00]
  B3: 9800  [numFmt: #,##0] [validation: list [North,South,East,West]]
  C3: 11050  [numFmt: #,##0]
  D3: 20850  [shared formula ref: D2] [numFmt: #,##0]
--- Row 4 (empty) [hidden] ---
```

### JSON dump (`--json`)

```json
{
  "name": "Sales",
  "rowCount": 4,
  "columnCount": 4,
  "frozen": { "rowSplit": 1, "colSplit": 0 },
  "columns": [{ "letter": "A", "width": 12 }, ...],
  "namedRanges": [{ "name": "Totals", "ranges": ["Sales!$D$2:$D$20"] }],
  "tables": [{ "name": "SalesTable", "ref": "A1:D20", "columns": ["Region", "Q1", "Q2", "Total"] }],
  "cells": [
    { "ref": "D2", "row": 2, "col": 4, "value": { "formula": "B2+C2", "result": 31700 }, "numFmt": "#,##0" },
    { "ref": "D3", "row": 3, "col": 4, "value": { "sharedFormulaRef": "D2", "result": 20850 }, "numFmt": "#,##0" }
  ]
}
```

### Sheet Metadata

| Line | Meaning |
|------|---------|
| `Frozen: row 1, col 2` | Frozen panes position |
| `Columns: A(12) B(20)` | Column widths (Excel character units) |
| `Hidden columns: E, F` | Columns hidden in the spreadsheet |
| `Merged: A1:B1` | Merged cell ranges |
| `Auto-filter: A1:D20` | Active auto-filter range |
| `Print area: A1:D50` | Defined print area |
| `Named ranges:` | Workbook-defined names referencing this sheet |
| `Table: "Name" A1:D20` | Excel Table objects with column headers |
| `Image: A1 to C5` | Embedded image position |

### Cell Tags

| Tag | Meaning |
|-----|---------|
| `[formula: =SUM(A1:A10)]` | Cell contains this formula (master cell) |
| `[shared formula ref: D2]` | Cell shares D2's formula (Excel "shared formula" — common when you drag-fill) |
| `[numFmt: 0.00%]` | Number format (when not "General") |
| `[bold]` | Bold font |
| `[italic]` | Italic font |
| `[color:FF8B0000]` | Font color (ARGB hex) |
| `[fill:FFFFFF00]` | Cell background color (ARGB hex) |
| `[align:center]` | Horizontal alignment (when not default) |
| `[link: https://...]` | Hyperlink URL |
| `[note: ...]` | Cell comment or note text |
| `[validation: list [...]]` | Data validation (dropdown values or constraints) |
| `[hidden]` | Row is hidden in the spreadsheet |

### `--list-sheets` Output

```
Sales  250 rows × 12 cols
Config  15 rows × 4 cols
Archive  1200 rows × 8 cols [hidden]
```

## Cursor / Claude / Agent Rule Template

Copy the included rule template into your project so your AI agent automatically uses this tool when it encounters `.xlsx` files:

```bash
mkdir -p .cursor/rules
cp node_modules/xlsx-for-ai/cursor-rule-template/read-xlsx.mdc .cursor/rules/
```

Or fetch it directly:

```bash
mkdir -p .cursor/rules
curl -o .cursor/rules/read-xlsx.mdc https://raw.githubusercontent.com/senoff/xlsx-for-ai/main/cursor-rule-template/read-xlsx.mdc
```

The same rule works for Claude Code (`.claude/rules/`), Copilot (`.github/copilot-instructions.md`), or any other agent — just adjust the path.

## Embedding xlsx-for-ai as a library dependency

The CLI install (`npm install -g xlsx-for-ai`) is clean — no deprecation warnings, modern transitive deps via npm `overrides`. If you embed xlsx-for-ai as a library dependency in another project, the picture is slightly different.

**Why:** npm's `overrides` field only takes effect when xlsx-for-ai is the top-level project. When xlsx-for-ai is installed as a *transitive* dependency in another project, npm uses the original ExcelJS dep tree (unmodified), and you'll see the upstream ExcelJS deprecation warnings on install. The warnings come from ExcelJS's stale transitive deps (`glob@7`, `rimraf@2`, `lodash.isequal`, `fstream`, `inflight`) and are upstream noise — they don't affect functionality.

**To get clean output in a project that depends on xlsx-for-ai**, copy the same overrides into your own `package.json`:

```json
{
  "overrides": {
    "glob": "^13.0.0",
    "rimraf": "^5.0.10",
    "unzipper": "^0.12.3",
    "fast-csv": "^5.0.2"
  }
}
```

Run `rm -rf node_modules package-lock.json && npm install` and the warnings will clear. xlsx-for-ai's tests pass against these versions, so the upgrade is safe.

`patch-package` is in `devDependencies` for authoring patches. The postinstall hook is *not* wired today — no patches exist, and a hook that tries to invoke a missing dev-only binary would break consumer installs. When the first patch lands, the hook is added in the same commit as the patch file.

### Audit findings on install

As of 1.5.4, `npm install xlsx-for-ai` finds **no inherited audit advisories**. The previous `xlsx` (sheetJS) and `uuid` findings were closed by:

- **`xlsx` removed in 1.5.4** — see [#26](https://github.com/senoff/xlsx-for-ai/issues/26). The legacy `.xls` / `.xlsb` / `.ods` input path that depended on it is no longer supported; the modern `@protobi/exceljs` engine handles `.xlsx` (and CSV / TSV continue to use `papaparse`).
- **`uuid` bumped to ^14 via `overrides`** — clears the `GHSA-w5hq-g745-h8pq` advisory inherited transitively from ExcelJS. Mirrors the upstream protobi/exceljs gift PR locally.

The triage workflow lives in [`.github/audit-allowlist.json`](.github/audit-allowlist.json) (currently empty) and `audit.yml` for whenever a future advisory needs accepting.

## Reporting bugs

**The privacy contract: we never auto-send workbook data.** Anonymous crash telemetry is opt-in via `--enable-telemetry`; even then, we receive only error type, error message (sanitized — paths scrubbed, capped at 200 chars), tool version, Node version, and OS/arch. No paths, no cell values, no identifiers.

To enable or manage crash telemetry:

```bash
# Opt in — prints the exact payload schema so you can see what gets sent
xlsx-for-ai --enable-telemetry

# Opt out
xlsx-for-ai --disable-telemetry

# Check current state and config path
xlsx-for-ai --telemetry-status
```

Consent is stored at `~/.xlsx-for-ai/config.json` and persists across `npm install -g xlsx-for-ai@latest` upgrades. If the telemetry shape ever changes, the tool pauses sending and prompts you to re-opt-in — we never silently expand what we collect under old consent.

When something breaks on a real workbook, two flags help us reproduce locally without asking you to share the original file:

```bash
# Required — small JSON describing the workbook's structure (no cell content)
npx xlsx-for-ai --report-bug your-file.xlsx

# Optional — full workbook with every cell value replaced by a typed placeholder
npx xlsx-for-ai --export-redacted-workbook your-file.xlsx
```

### `--report-bug`

Writes `xlsx-for-ai-bugreport-<ISO-timestamp>.json` to the current directory. The report contains:

- File size, sheet count, per-sheet shape (rows × cols), per-sheet merge counts
- Feature inventory detected via OOXML part inspection — pivot tables, charts, threaded comments, sensitivity labels, linked data types, sparklines, Power Query, slicers, timelines, dynamic arrays, conditional formatting, VBA, and more
- Defined-name *labels* (e.g. `Totals`) — but NOT their target ranges or formulas
- Tool version, Node version, OS + arch

What the report **never** contains: cell values, formulas, shared strings, named-range targets, comment text, or your absolute file path. You can `cat` it before attaching to verify.

### `--export-redacted-workbook`

Writes `<input>-redacted.xlsx` next to the input. Every cell value is replaced by a typed placeholder:

| Original cell type | Placeholder |
|--------------------|-------------|
| Number             | `0`         |
| String             | `"x"`       |
| Boolean            | `false`     |
| ISO date           | `1899-12-30`|
| Error              | preserved   |

Formulas, sheet names, merges, named ranges (formulas), styles, conditional formatting, pivots, charts, queries, and macros are passed through byte-for-byte at the ZIP/XML level (no lossy ExcelJS round-trip). Shared strings and comment payloads are also rewritten to `"x"` for defense-in-depth. Open the redacted file in Excel to confirm it still triggers the bug, then attach it.

### Filing the issue

Open https://github.com/senoff/xlsx-for-ai/issues — the bug template asks you to drag-drop the JSON (and optionally the redacted workbook). That's the whole workflow. No accounts to create, no SDK to integrate, no consent screen to click through.

## Why This Exists

Spreadsheets are everywhere in real projects — financial models, data exports, config files, tax estimates. AI coding agents choke on binary formats. This tool makes spreadsheets legible to AI with zero information loss, including the tricky bits like shared formulas, named ranges, and merged cells that other tools drop.

## Security

`xlsx-for-ai` parses untrusted `.xlsx` files on your machine. The
project's security policy, supported-versions table, and reporting inbox
are in [SECURITY.md](SECURITY.md). The supply-chain hardening that goes
with it lives in [docs/INTEGRITY_PINNING.md](docs/INTEGRITY_PINNING.md)
and [FORK_READINESS.md](FORK_READINESS.md).

## License

MIT
