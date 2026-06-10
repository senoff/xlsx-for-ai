# xlsx-for-ai

*Short name: **xfa** — a real CLI command (`xfa <file>`, `xfa samples`, `xfa --version`) and the prompt shorthand (e.g. "use xfa to read this file"). Same entrypoint as `xlsx-for-ai`; matches the internal `xfa_*` / `XFA_*` brand surface.*

**The missing reliability layer that makes spreadsheet reasoning production-grade for LLMs.**

A thin npm client over a hosted API. Install once, add to your agent config, and your agent gets 50 production-grade tools for reading, writing, diffing, redacting, healing, and cryptographically attesting `.xlsx` files — engine complexity runs server-side, engine IP stays private.

```bash
npm install -g xlsx-for-ai
```

The global install puts the `xlsx-for-ai-mcp` binary on your PATH — that's what the canonical configs below point at. A pinned global install launches fast and works offline; upgrade with `npm install -g xlsx-for-ai@latest` when a new version ships.

> **Upgrading from 1.5.x?** This is a re-architecture, not a feature bump: the heavy local engine is gone from the npm package. All rendering happens server-side. The `cursor-reads-xlsx` alias still works. See [Migration](#migration-from-15x) below.

---

## MCP configuration

Add the server to your agent runtime under the name **`xfa`** (so "use xfa to read this" resolves). First invocation auto-registers an anonymous client UUID — no email, no signup, no friction.

### Claude Code

The global install auto-registers the `xfa` MCP server in `~/.claude.json` — no extra step:

```bash
npm install -g xlsx-for-ai
```

If your environment skips install scripts (`--ignore-scripts`, CI, or a sudo install), register it manually:

```bash
claude mcp add xfa -- xlsx-for-ai-mcp
```

Verify: in a new Claude Code session, ask "what MCP tools do you have?" — 50 `xlsx_*` tools should appear, including `xlsx_doctor` (one-call health report — try it first on any unknown workbook).

Then run `xfa samples` (shorthand for `xlsx-for-ai samples`) to drop two demo workbooks in your working directory and get paste-ready prompts to try.

### Cursor

Config file: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: open Cursor settings → MCP → confirm `xfa` shows 50 `xlsx_*` tools.

### Continue

Config file: `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "xfa",
      "command": "xlsx-for-ai-mcp"
    }
  ]
}
```

Verify: restart VS Code, open the Continue panel, and check the MCP server list.

### Codex CLI

Pass `--mcp-server` on the command line, or add to your Codex config:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: run `codex --list-tools` and confirm 50 `xlsx_*` tools are listed.

### Zed

Config file: `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "xfa": {
      "command": {
        "path": "xlsx-for-ai-mcp"
      }
    }
  }
}
```

Verify: open Zed's assistant panel — the xlsx tools should appear in the tool picker.

### Windsurf

Config file: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: open Windsurf → Cascade → settings, confirm `xfa` is listed as an active MCP server.

### Custom agents / API

For custom MCP clients, the binary is `xlsx-for-ai-mcp` (stdio transport). Override the API base URL with the `XLSX_FOR_AI_API` env var for local dev against `http://localhost:3000`.

---

## What it does

50 tools registered in `tools/list`. Descriptions are intentionally rich — an agent reading a transcript can tell what each tool does and when to reach for it, without extra docs.

### Triage / orient

| Tool | What it does |
|---|---|
| `xlsx_doctor` | **One-call workbook health report.** HIGH/MEDIUM/LOW findings (macros, external links, hidden sheets, missing metadata, large images) + quick facts + feature flags. The first call to make on an unknown workbook. |
| `xlsx_topology` | One-call workbook orientation: sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot. |
| `xlsx_list_sheets` | List all sheet names and metadata. Fast first-call before reading. |
| `xlsx_schema` | Infer column types, nullable flags, header row, and sample values per sheet. |
| `xlsx_describe` | Pandas-style `.describe()` on every numeric column — count, mean, std, min, max, quartiles. |
| `xlsx_workbook_views` | UI state — frozen panes, zoom, active cell, hidden / veryHidden sheets, tab colors, active tab. |
| `xlsx_properties` | Workbook metadata — creator, modified, company, title, custom doc properties. |

### Read / write

| Tool | What it does |
|---|---|
| `xlsx_read` | Read a workbook — text, JSON, or markdown. Formulas, named ranges, layout, and data types preserved. |
| `xlsx_read_handle` | Read by server-side handle instead of bytes — for session flows where the workbook has already been uploaded and shouldn't be transferred again. |
| `xlsx_write` | Create or update a workbook from a structured spec. Multi-sheet, formulas, named ranges, table definitions. |
| `xlsx_data_clean` | Normalize messy data in place — trim whitespace, coerce types, dedupe rows, fix obvious encoding artifacts. Returns a cleaned copy + a change log. Save-As shape; never mutates the input. |
| `xlsx_diff` | Semantic diff between two workbooks — cell-level deltas, formula changes, structural shifts. Deterministic output. |
| `xlsx_redact` | Redact PII from a workbook before sharing. Server-side detection; returns redacted copy plus audit manifest. |
| `xlsx_convert` | 25+ in / 16 out formats (csv, tsv, html, ods, xls, xlsb, dif, sylk, prn, txt, dbf, eth, json, markdown, xlsx, etc.). |
| `xlsx_validate` | Cross-engine consistency check — runs the workbook through TWO independent renderers and reports cell-level divergences. |
| `xlsx_session_set_validations` | Configure per-session validation rules the server will apply to subsequent calls in the same session (e.g., reject rows missing required columns). Stateful — affects this session only. |

### Pandas-parity (compute fresh aggregates)

| Tool | What it does |
|---|---|
| `xlsx_filter` | Filter rows by predicate (column op value). Returns matched rows with optional projection. |
| `xlsx_aggregate` | Group-by + aggregate (sum / count / mean / min / max / median / std). |
| `xlsx_sort` | Multi-column sort with ascending / descending per column. |
| `xlsx_value_counts` | Frequency table for a column (pandas `.value_counts()`). |
| `xlsx_pivot` | Compute a fresh pivot table from raw data — pandas `pivot_table()` shape. |
| `xlsx_eval` | Evaluate freeform formulas or recompute cell refs via HyperFormula (BSD pure-JS, ~390 functions, no I/O). |

### Structure-preservation — the moat (pandas drops every one of these on read)

| Tool | What it does |
|---|---|
| `xlsx_named_ranges` | List every named range with scope, ref, and value preview. |
| `xlsx_tables` | List Excel ListObjects (Tables) with column headers, data range, totals row. |
| `xlsx_formulas` | Dump every formula across the workbook (cell, sheet, formula text, cached value). |
| `xlsx_data_validations` | List cell-level validation rules (dropdowns, numeric/date bounds, text-length, custom). |
| `xlsx_hyperlinks` | List hyperlinks with kind classifier (external / internal / mailto / unknown). |
| `xlsx_conditional_formats` | List CF rules (color scales, data bars, icon sets, formula-based highlights, top-N, duplicates). |
| `xlsx_styles` | Number formats + fonts + fills + alignment, rolled up per sheet or detailed per cell. |
| `xlsx_comments` | Both legacy notes AND threaded conversations (multi-author, with display-name resolution). |
| `xlsx_protection` | Sheet locks + per-cell locked/hidden flags + workbook structure/window locks. |
| `xlsx_merged_cells` | Layout-aware merge listing with master values + kind heuristic (header / horizontal / vertical / block). |
| `xlsx_charts` | Chart spec (type, title, series formula refs, axis titles) — ExcelJS doesn't expose these at all. |
| `xlsx_images` | Embedded image inventory (format, size, sheet, anchor cells). |
| `xlsx_pivot_tables` | Pre-existing pivot definitions — location, source, row/col/page/data fields with agg functions. |
| `xlsx_slicers_timelines` | Modern Excel filter UI — slicers (table/pivot bound) + timelines (date-range with selection). |
| `xlsx_external_links` | Workbook-to-workbook references with target classification + warning when paths break on share. |
| `xlsx_print_settings` | "What would Excel print?" — print area, paper size, margins, headers/footers, print titles. |
| `xlsx_form_controls` | Interactive widgets — checkboxes, buttons, drop-downs, spinners, scroll bars, list boxes — with linked cell + bounds. |
| `xlsx_macros` | VBA macro presence + module-name heuristics + safety advice (does NOT extract source by policy). |

### Integrations

| Tool | What it does |
|---|---|
| `xlsx_post_slack` | Post a workbook to a Slack channel as a file attachment with an optional message. BYOA — the agent supplies the user's Slack bot token (`xoxb-…`); the token is forwarded to Slack and never persisted. Uses Slack's external upload flow. |
| `xlsx_post_teams` | Post a workbook to a Microsoft Teams channel as a file attachment in a channel message, with an optional message. BYOA — the agent supplies the user's Microsoft Graph access token (JWT); the token is forwarded to Microsoft and never persisted. Uses Graph's filesFolder + upload-session + post-message flow. |

### Integrity verification

| Tool | What it does |
|---|---|
| `xlsx_stamp` | Sign a workbook with a cryptographic "integrity verification" stamp — Ed25519-signed claims (named factual checks + their pass/fail/skip status + a content hash) embedded in `docProps/custom.xml`. The stamp travels with the file across saves; a recipient can verify it later to confirm the file hasn't been tampered with since signing. Factual attestations only — never an opinion-shaped seal of approval. |
| `xlsx_verify_stamp` | Verify a workbook's embedded stamp. Returns (a) whether the Ed25519 signature is valid against the registered public key, (b) whether the workbook bytes match the hash IN the signed claims, and (c) the full check-result content of the stamp. Three distinct trust signals — signature integrity, content integrity, and what was originally attested. |
| `xlsx_receipt` | Attach an AI-generation receipt — Ed25519-signed claims describing the caller-declared agent identity (name, display name, identity URL), generation timestamp, content hash, optional source-file hashes, optional prompt hash, optional MCP tools called, and an optional description. Honesty boundary (load-bearing): the server signs the caller-declared `agent.name` — it does NOT verify the caller actually IS that agent. Cryptographic identity binding (per-agent issued signing keys) is v1.1+ scope. |
| `xlsx_verify_receipt` | Verify a workbook's embedded receipt. Returns the same three trust signals as `xlsx_verify_stamp` plus the caller-declared agent identity AS declared (no UI affordances implying cryptographic identity verification). Use to surface "where did this file come from?" — backed by the server's signature over caller honest declaration. |

### Healer — external-reference breakage

Workbooks rot. A file moves and `#REF!` propagates through every dependent formula. A Power Query connection embeds credentials nobody can rotate. A defined name points at an external workbook that doesn't exist anymore. The healer family diagnoses these classes and applies targeted cures — read-only diagnosis, simulated-before-applied repair, and a high-level intent path when the agent doesn't want to spell out individual cure operations.

| Tool | What it does |
|---|---|
| `xlsx_healer_diagnose` | Structured report of external-reference breakage — broken external refs, defined-name external refs, Power Query connections with embedded credentials, `#REF!` propagation maps, multi-hop chains. Read-only. |
| `xlsx_healer_simulate` | Show what a specific cure operation would change before applying it — same shape as `xlsx_healer_cure` but read-only. Use to preview impact when the agent is uncertain whether to proceed. |
| `xlsx_healer_cure` | Apply ONE specific cure operation (e.g., strip broken external refs, harmonize a defined name, replace `#REF!` propagation with a deterministic value). Save-As shape; the source workbook is preserved unless `confirm:true` is set with `mode:"in_place"`. |
| `xlsx_healer_intent` | High-level intent path — `make-it-work`, `make-standalone`, `migrate` — translated into the right sequence of cure ops. For when the agent knows the goal but not the operation. |

Tool responses include a citation footer and a `_meta` block (tool name, version, tier, request ID, `powered_by`). Both pass through verbatim; nothing is stripped.

---

## Tools

All **50 tools** the MCP server exposes (generated from `tools/list`). Invoke any by asking your agent in plain English, or call the API/CLI directly.

**Read & explore**

- `xlsx_read` — read an .xlsx file by path and return a rendered markdown/JSON/SQL representation.
- `xlsx_read_handle` — read a workbook that has already been uploaded to the server via the chunked upload flow, by its server-side cache handle, WITHOUT re-transferring the bytes. Returns the same shape as xlsx_read (text / json / markdown) but skips the file_b64 round-trip.
- `xlsx_validate` — cross-engine consistency check on a LOCAL .xlsx file — runs the workbook through TWO independent renderers (@protobi/exceljs and @cj-tech-master/excelts) and reports cell-level divergences.

**Inspect structure**

- `xlsx_charts` — List every chart in a LOCAL .xlsx file with type (bar / line / pie / scatter / area / doughnut / radar / stock / surface / bubble), title, axis titles, and per-series formula refs (the cell ranges the chart pulls from). Sheet attribution via the OOXML drawing rel chain.
- `xlsx_comments` — list every cell comment in a workbook — both legacy notes (yellow stickies, cell.note) AND modern threaded comments (multi-author conversations stored separately in the OOXML zip). Per entry: kind, sheet, cell, author, text, plus any reply thread.
- `xlsx_conditional_formats` — list every conditional formatting rule in a workbook — color scales, data bars, icon sets, formula-based highlights, top-N, duplicate / unique values, contains-text, time-period, above-average. Per rule: range, type, operator, formulae, priority, stopIfTrue.
- `xlsx_data_validations` — list every cell-level data validation rule (dropdowns, numeric/date bounds, text-length caps, custom formulas) defined in a workbook — the constraints that Excel enforces when a human types into the cell.
- `xlsx_describe` — pandas-style df.describe() per column — count, nulls, unique, min/max/mean/std for numerics, dtype with purity score.
- `xlsx_external_links` — list every external workbook reference this file depends on — `=[Budget.xlsx]Sheet1!A1` style formulas. Per link: target path (decoded), classification (http / network share / absolute / relative), sheets pulled from the external workbook, count of cached cell values, and defined-name references.
- `xlsx_form_controls` — list every form control (Check Box, Button, Drop-down, List Box, Option Button, Scroll Bar, Spinner, Label, Group Box) in a workbook with the linked cell, current value, dropdown source range, and min/max/step bounds where applicable.
- `xlsx_formulas` — extract every formula in a LOCAL .xlsx workbook — cell coord (A1), formula text, cached result. openpyxl-style read-only metadata.
- `xlsx_hyperlinks` — list every hyperlink in a workbook with its anchor cell, target URL/anchor, display text, tooltip, and a kind classifier (external / internal / mailto / unknown).
- `xlsx_images` — List every embedded image in a LOCAL .xlsx file with format (png / jpg / gif / svg / bmp / tiff / emf / wmf), size in bytes, sheet attribution, and anchor cell range (the cells the image floats over). Reads xl/media/* + xl/drawings/* directly.
- `xlsx_list_sheets` — list sheet names, dimensions, and visibility for a LOCAL .xlsx file.
- `xlsx_macros` — Inspect xlsm / xlsb workbooks for VBA macro presence, vbaProject.bin size, and likely module names (ThisWorkbook / Sheet<N> / Module<N> / Class<N> / UserForm<N> via heuristic UTF-16LE scan). Returns short safety advice the LLM should relay to the user.
- `xlsx_merged_cells` — list every merged-cell region with master-cell value, range, span dimensions, and kind heuristic ("header" / "horizontal" / "vertical" / "block"). Pandas reads merged cells by dropping the relationship — it sees one value in the master cell and three blanks alongside. xlsx_merged_cells is the layout-aware view: "A1:D1 is ONE cell that says Q4 2024" rather than four cells where three are mysteriously empty.
- `xlsx_named_ranges` — list all defined names (named ranges) in a LOCAL .xlsx workbook — name, scope (workbook or sheet), kind (cell / range / formula), reference.
- `xlsx_pivot_tables` — List every PRE-EXISTING pivot table definition in a LOCAL .xlsx file (the ones an Excel user already built). Per pivot: sheet, name, location range, source range (or named-range / table reference), row / column / page fields, and data fields with their agg function (sum / count / average / max / min / product / stdDev / etc.).
- `xlsx_print_settings` — surface "what would Excel print right now" per worksheet — print area, orientation, paper size (A4 / Letter / Legal / Tabloid / etc.), scale or fitToPage, margins, headers/footers split into Excel's L/C/R zones, print titles (rows / columns repeated on every page), manual page breaks, plus B&W / draft / centered flags.
- `xlsx_properties` — Surface the workbook's identity card from a LOCAL .xlsx file. Core: creator, last_modified_by, created/modified/lastPrinted timestamps, title, subject, company, manager, keywords, category, description. Application: app name + version, doc security label, hyperlink base. Custom: every user-defined Info > Properties entry (Department, ReviewedBy, ApprovalRequired, etc.) with type tag and value.
- `xlsx_protection` — Surface every protection setting in a LOCAL .xlsx file so an agent knows what it can and cannot edit. Workbook-level (lockStructure, lockWindows), per-sheet (protected? password? hidden state?), per-action allow/block list (formatCells, sort, insertRows, pivotTables, etc.), and per-cell unlocked / hidden samples — these are the cells a human would actually be allowed to type into when the sheet is otherwise read-only.
- `xlsx_schema` — infer column schema of a LOCAL .xlsx file — types, nullable flags, header row, sample values.
- `xlsx_slicers_timelines` — List every slicer (interactive filter button) and timeline (date-range filter visual) in a LOCAL .xlsx file with their captions, source bindings (table column or pivot table), and timeline granularity (years / quarters / months / days) plus the currently-selected date range.
- `xlsx_styles` — surface cell formatting (number formats, fonts, fills, alignment) so an agent knows what a cell LOOKS like, not just its raw value. Default mode: per-sheet rollup of top-N number formats / fonts / fills with counts. Detailed mode (opt-in, capped at 1000 cells): per-cell breakdown for narrow queries.
- `xlsx_tables` — list every Excel ListObject ("Format as Table" structures) in a LOCAL .xlsx workbook — name, sheet, range, header/totals flags, columns.
- `xlsx_workbook_views` — Surface the UI state of a LOCAL .xlsx file — what a human sees when they open it in Excel. Per sheet: visibility (visible / hidden / veryHidden), view state, zoom, active cell + selection, frozen-pane breakdown, gridlines / row-col headers / ruler / RTL flags, tab color. Workbook level: which sheet is active when Excel opens.

**Query & analyze**

- `xlsx_aggregate` — pandas-style df.groupby([cols]).agg({col: func}) on a LOCAL .xlsx file. funcs: sum / mean / min / max / count / count_distinct.
- `xlsx_diff` — compute a semantic diff between two LOCAL .xlsx files — cell-level deltas, formula changes, added/removed rows.
- `xlsx_eval` — evaluate Excel formulas against a LOCAL .xlsx file via HyperFormula. xlwings-style.
- `xlsx_filter` — pandas-style row filter on a LOCAL .xlsx file with predicates AND-combined: eq/ne/gt/gte/lt/lte/contains/in/is_null/not_null.
- `xlsx_pivot` — pandas-style pivot_table() on a LOCAL .xlsx file — reshape a flat table into a 2D matrix where rows are unique values of `index`, columns are unique values of `columns`, and cells are an aggregation of `values`.
- `xlsx_sort` — pandas-style df.sort_values() on a LOCAL .xlsx file with multi-column sort and per-column direction (asc/desc, default asc).
- `xlsx_topology` — one-call workbook orientation. Returns sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot, plus feature flags (macros / external refs / pivots / LAMBDA / dynamic arrays).
- `xlsx_value_counts` — pandas-style Series.value_counts() on one column of a LOCAL .xlsx file — count each unique value, sorted by frequency desc, with percentage.

**Clean & fix**

- `xlsx_data_clean` — AI-native data cleaning for a LOCAL .xlsx file. Scans for the seven most common data-grime issues — NA variants (N/A, NA, null, -), merged-cell residue, type-coercion mistakes (numeric-as-text / date-as-serial / leading-zero stripped), trailing-row noise (footers / totals), header-row-not-first (preamble before headers), encoding glitches (UTF-8-as-CP1252 mojibake), and duplicate column headers — and either flags them (diagnose mode) or applies deterministic fixes (execute mode).

**Convert**

- `xlsx_convert` — universal spreadsheet format converter. Reads ANY of 25+ input formats (xlsx, xlsb, xlsm, xls, ods, fods, numbers, csv, tsv, dbf, lotus 1-2-3, quattro pro, sylk, dif, html, rtf, etc.) and emits ANY supported output format (xlsx, csv, json, md, html, etc.).

**Write (new file)**

- `xlsx_redact` — redact PII and sensitive values from a LOCAL .xlsx file before sharing or archiving.
- `xlsx_write` — create or update a LOCAL .xlsx file from a structured spec.

**Integrity & verification**

- `xlsx_healer_cure` — Apply ONE specific cure operation against a diagnosed workbook. Operations: rename_move (rewrite ref paths), pattern_bulk (regex-style ref rewrites), source_deleted_freeze (replace broken refs with cached values), source_deleted_redirect (point at a replacement file), source_deleted_localize (snapshot external source into a local copy), permission_denied (strip credentials), structure_changed (rewrite formulas for moved cells), format_change (re-link after extension change), make_standalone (fully dereference all externals). Returns cured workbook bytes + receipt.
- `xlsx_healer_diagnose` — produce a structured diagnostic report of external references that are broken or at risk in a workbook. Returns five classes of finding: (1) external-workbook references that can't resolve, (2) defined-name external refs, (3) Power Query connections with embedded credentials, (4) #REF! propagation maps from upstream breakage, (5) multi-hop chains (workbook → workbook → workbook). Findings carry reference_id keys that downstream cure operations key on.
- `xlsx_healer_intent` — Goal-driven healing. Caller declares an INTENT (`make-it-work`, `make-standalone`, or `migrate`) instead of a specific cure operation; Healer plans the operation sequence + applies it. make-it-work: minimum surgery to clear errors. make-standalone: fully de-externalize (snapshot every external dep). migrate: rewrite all references against a from/to prefix pair. Returns the planned operations, cured bytes, and an unactionable list.
- `xlsx_healer_simulate` — simulate recipient-side accessibility of a workbook's external references. Given a list of paths the recipient CAN see (`accessible_paths`), returns which references will still resolve at the recipient end and which will break (and why). Read-only; produces no output workbook.
- `xlsx_receipt` — Attach an AI-generation receipt to a LOCAL .xlsx file — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by THIS agent, at THIS time, against THESE inputs." Returns the receipted workbook as base64 in _meta.file_b64; pass out_path to write to disk.
- `xlsx_stamp` — Sign a LOCAL .xlsx file with a "workbook integrity verification" stamp — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by these tools, passed these N specific checks, signed at this time, and hasn't been tampered with since." Factual claims only (never an opinion-shaped seal of approval). Returns the stamped workbook as base64 in _meta.file_b64; pass out_path to write to disk.
- `xlsx_verify_receipt` — verify a workbook's embedded AI-generation receipt. Returns whether the signature is valid, whether the recomputed content hash matches the hash IN the receipt, and the full caller-declared claims (agent identity, generation timestamp, source-file hashes, prompt hash, MCP tools called, description).
- `xlsx_verify_stamp` — verify a workbook's embedded integrity-verification stamp. Returns whether the cryptographic signature is valid, whether the workbook bytes match what was signed (recomputed hash vs hash IN the stamp), and the full check-result content of the stamp.

**Integrations**

- `xlsx_post_slack` — upload a local .xlsx file to a Slack channel as a file attachment, with an optional accompanying message.
- `xlsx_post_teams` — Upload a local .xlsx file to a Microsoft Teams channel as a file attachment, with an optional accompanying message.

**Session**

- `xlsx_session_set_validations` — configure per-session data-validation rules the server will apply to subsequent calls in the same session (e.g., reject rows missing required columns, enforce enum values on a category column, range-bound numeric inputs). Stateful — affects this session only.

**One-call capstone**

- `xlsx_doctor` — ONE-CALL workbook health report for a LOCAL .xlsx file. Scans for macros, external workbook references, hidden / veryHidden sheets, missing creator metadata, large embedded images, and surfaces interesting feature flags (LAMBDA, dynamic arrays, pivot cache, slicers, threaded comments). Findings ranked HIGH / MEDIUM / LOW. Plus quick_facts: sheet count, formulas, named ranges, merges, hyperlinks, validations, images, file size.

---

## Functions

`xlsx_eval` recalculates formulas with [HyperFormula](https://hyperformula.handsontable.com) v3.2.0 — **382 Excel functions** across these categories:

- **Math & trig** (101) — ABS, ACOS, ACOSH, ACOT, ACOTH, ARABIC, ASIN, ASINH, ATAN, ATAN2, ATANH, AVERAGE, AVERAGEA, AVERAGEIF, CEILING, CEILING.MATH, CEILING.PRECISE, COMBIN, COMBINA, COS, COSH, COT, COTH, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, COUNTUNIQUE, CSC, CSCH, DEGREES, EVEN, EXP, FACT, FACTDOUBLE, FLOOR, FLOOR.MATH, FLOOR.PRECISE, GCD, INT, ISO.CEILING, LCM, LN, LOG, LOG10, MAX, MAXA, MAXIFS, MIN, MINA, MINIFS, MOD, MROUND, MULTINOMIAL, ODD, PI, POWER, PRODUCT, QUOTIENT, RADIANS, RAND, RANDBETWEEN, ROMAN, ROUND, ROUNDDOWN, ROUNDUP, SEC, SECH, SERIESSUM, SIGN, SIN, SINH, SQRT, SQRTPI, STDEV, STDEV.P, STDEV.S, STDEVA, STDEVP, STDEVPA, STDEVS, SUBTOTAL, SUM, SUMIF, SUMIFS, SUMPRODUCT, SUMSQ, SUMX2MY2, SUMX2PY2, SUMXMY2, TAN, TANH, TRUNC, VAR, VAR.P, VAR.S, VARA, VARP, VARPA, VARS
- **Statistical** (108) — AVEDEV, BESSELI, BESSELJ, BESSELK, BESSELY, BETA.DIST, BETA.INV, BETADIST, BETAINV, BINOM.DIST, BINOM.INV, BINOMDIST, CHIDIST, CHIDISTRT, CHIINV, CHIINVRT, CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, CHISQ.TEST, CHITEST, CONFIDENCE, CONFIDENCE.NORM, CONFIDENCE.T, CORREL, COVAR, COVARIANCE.P, COVARIANCE.S, COVARIANCEP, COVARIANCES, CRITBINOM, DEVSQ, ERF, ERFC, EXPON.DIST, EXPONDIST, F.DIST, F.DIST.RT, F.INV, F.INV.RT, F.TEST, FDIST, FDISTRT, FINV, FINVRT, FISHER, FISHERINV, FTEST, GAMMA, GAMMA.DIST, GAMMA.INV, GAMMADIST, GAMMAINV, GAMMALN, GAMMALN.PRECISE, GAUSS, GEOMEAN, HARMEAN, HYPGEOM.DIST, HYPGEOMDIST, LARGE, LOGINV, LOGNORM.DIST, LOGNORM.INV, LOGNORMDIST, LOGNORMINV, MEDIAN, NEGBINOM.DIST, NEGBINOMDIST, NORM.DIST, NORM.INV, NORM.S.DIST, NORM.S.INV, NORMDIST, NORMINV, NORMSDIST, NORMSINV, PEARSON, PHI, POISSON, POISSON.DIST, POISSONDIST, RSQ, SKEW, SKEW.P, SKEWP, SLOPE, SMALL, STANDARDIZE, STEYX, T.DIST, T.DIST.2T, T.DIST.RT, T.INV, T.INV.2T, T.TEST, TDIST, TDIST2T, TDISTRT, TINV, TINV2T, TTEST, WEIBULL, WEIBULL.DIST, WEIBULLDIST, Z.TEST, ZTEST
- **Financial** (28) — CUMIPMT, CUMPRINC, DB, DDB, DOLLARDE, DOLLARFR, EFFECT, FV, FVSCHEDULE, IPMT, IRR, ISPMT, MIRR, NOMINAL, NPER, NPV, PDURATION, PMT, PPMT, PV, RATE, RRI, SLN, SYD, TBILLEQ, TBILLPRICE, TBILLYIELD, XNPV
- **Date & time** (27) — DATE, DATEDIF, DATEVALUE, DAY, DAYS, DAYS360, EDATE, EOMONTH, HOUR, INTERVAL, ISOWEEKNUM, MINUTE, MONTH, NETWORKDAYS, NETWORKDAYS.INTL, NOW, SECOND, TEXT, TIME, TIMEVALUE, TODAY, WEEKDAY, WEEKNUM, WORKDAY, WORKDAY.INTL, YEAR, YEARFRAC
- **Text** (26) — CHAR, CLEAN, CODE, CONCATENATE, EXACT, FIND, FORMULATEXT, HYPERLINK, LEFT, LEN, LOWER, MID, N, PROPER, REPLACE, REPT, RIGHT, SEARCH, SPLIT, SUBSTITUTE, T, TRIM, UNICHAR, UNICODE, UPPER, VALUE
- **Logical** (12) — AND, CHOOSE, FALSE, IF, IFERROR, IFNA, IFS, NOT, OR, SWITCH, TRUE, XOR
- **Lookup & reference** (13) — ADDRESS, ARRAYFORMULA, ARRAY_CONSTRAIN, FILTER, HLOOKUP, MATCH, MAXPOOL, MEDIANPOOL, MMULT, OFFSET, TRANSPOSE, VLOOKUP, XLOOKUP
- **Information** (21) — COLUMN, COLUMNS, INDEX, ISBINARY, ISBLANK, ISERR, ISERROR, ISEVEN, ISFORMULA, ISLOGICAL, ISNA, ISNONTEXT, ISNUMBER, ISODD, ISREF, ISTEXT, NA, ROW, ROWS, SHEET, SHEETS
- **Engineering** (46) — BASE, BIN2DEC, BIN2HEX, BIN2OCT, BITAND, BITLSHIFT, BITOR, BITRSHIFT, BITXOR, COMPLEX, DEC2BIN, DEC2HEX, DEC2OCT, DECIMAL, DELTA, HEX2BIN, HEX2DEC, HEX2OCT, IMABS, IMAGINARY, IMARGUMENT, IMCONJUGATE, IMCOS, IMCOSH, IMCOT, IMCSC, IMCSCH, IMDIV, IMEXP, IMLN, IMLOG10, IMLOG2, IMPOWER, IMPRODUCT, IMREAL, IMSEC, IMSECH, IMSIN, IMSINH, IMSQRT, IMSUB, IMSUM, IMTAN, OCT2BIN, OCT2DEC, OCT2HEX

The engine has no `INDIRECT`, `WEBSERVICE`, `RTD`, `DDE` — there is no dynamic-reference, network, or external-data function in the set, so a recalc can't reach off-workbook. The absent functions are the sandbox boundary.

---

## FP&A workflows

xlsx-for-ai is built for agents working on real financial spreadsheets. Common workflows:

**Budget vs. actual variance analysis**
```
xlsx_read → extract actuals and budget → agent computes variances → xlsx_write → deliver updated workbook
```

**Month-end reconciliation**
```
xlsx_read (bank export) + xlsx_read (GL extract) → agent matches rows → xlsx_diff → audit trail of unmatched items
```

**Audit-trail extraction**
```
xlsx_schema → identify change-log columns → xlsx_read with sheet filter → agent summarizes changes by author/date
```

**Multi-entity consolidation**
```
xlsx_read × N entity files → agent aggregates → xlsx_write → consolidated workbook with intercompany eliminations noted
```

**Pre-share PII redaction**
```
xlsx_redact → strips SSNs, emails, employee IDs → redacted file safe for external distribution
```

These workflows are the reason tool descriptions are FP&A-legible: when a developer builds an agent for a finance team, the agent's LLM reads the tool descriptions and routes correctly without extra prompt engineering.

---

## Reliability features

- **Deterministic diffs.** `xlsx_diff` produces identical output for identical inputs — safe to version-control, safe to assert against in CI.
- **Confidence-rated schema inference.** `xlsx_schema` returns type confidence scores alongside inferred types. Agents can branch on confidence rather than trusting a blind guess.
- **Audit trail.** Every tool call — success or failure — is logged server-side with timestamp, client ID, endpoint, file size, latency, and error class.
- **Hardened input validation.** Four pre-engine guards on every uploaded buffer: billion-laughs XML bomb defense, control-character stripping, worksheet buffer ceiling (slow ZIP-bomb defense), and typed error chaining. Applied before the xlsx engine sees any bytes.
- **Agent-readable errors.** Rate-limit and validation errors return structured JSON — agents can read them and prompt the user intelligently, not just surface a status code.

---

## Privacy

Files are transmitted to `https://api.xlsx-for-ai.dev` over HTTPS and processed in memory. Files are not persisted beyond the duration of a single request. No email is collected. Registration is anonymous UUID only.

See [PRIVACY.md](PRIVACY.md) for the full data-handling policy.

---

## What it costs

Free. All 50 tools, no paid tiers. No credit card, no email — registration is an anonymous client UUID created on first call. A volume cap (10,000 calls/month) keeps the hosted API healthy; that's the only limit.

---

## License

The npm client (`xlsx-for-ai`, this package) is MIT. The hosted API server (`xlsx-for-ai-server`) is proprietary — engine IP, rendering pipeline, and semantic-diff algorithm are not open source.

---

## Architecture

```
agent (Claude Code / Cursor / Continue / Zed / Windsurf / custom)
  └── MCP stdio
        └── xlsx-for-ai-mcp  (this package, ~200 lines)
              └── POST /api/v1/tools/<name>  →  api.xlsx-for-ai.dev
                    └── server-side engine (ExcelJS, formula eval, schema inference, redaction)
```

**Requirements:** Node.js 22+. 1.5.x line stays maintained on `main` for users who cannot upgrade.

---

## Config

Stored at `~/.xlsx-for-ai/config.json`. Created automatically on first run.

```json
{
  "client_id": "<uuid>",
  "api_key": "<opaque>",
  "registered_at": "2026-05-05T00:00:00.000Z",
  "telemetry": false,
  "consent_version": 1
}
```

Telemetry is opt-in:

```bash
xlsx-for-ai --enable-telemetry
xlsx-for-ai --disable-telemetry
xlsx-for-ai --telemetry-status
```

**Privacy modes** — error-capture is off by default; when enabled, cell values are stripped before anything is retained (structure only, 30-day TTL, never used for training). `XFA_PRIVACY=strict` opts out entirely. See [PRIVACY.md](PRIVACY.md):

```bash
# Per-session flag (applies to all tool calls in the CLI invocation)
xlsx-for-ai --privacy=strict myfile.xlsx

# Environment variable (applies globally to all requests in the process)
XFA_PRIVACY=strict xlsx-for-ai myfile.xlsx

# In MCP server config (applies to all tool calls from the MCP server):
# Set XFA_PRIVACY=strict in your MCP server's env block
```

Delete the config to reset your client ID and API key:

```bash
rm ~/.xlsx-for-ai/config.json
```

---

## Migration from 1.5.x

| Was | Now |
|---|---|
| All rendering local | All rendering server-side |
| `xlsx-for-ai <file>` CLI | Same — still works |
| `cursor-reads-xlsx` | Still works — back-compat alias |
| `--list-sheets`, `--schema`, `--diff`, etc. | Moved to MCP tools (`xlsx_list_sheets`, `xlsx_schema`, `xlsx_diff`) |
| `--export-redacted-workbook` | Moved to `xlsx_redact` MCP tool |
| Heavy npm install (~50 MB) | Thin install (~2 MB); engine stays server-side |
| PII detection, region scoring | Moved server-side; not exposed in the npm package |

The config file at `~/.xlsx-for-ai/config.json` is extended in-place — existing telemetry consent is preserved.

---

## Security

See [SECURITY.md](SECURITY.md). All file content is transmitted to `https://api.xlsx-for-ai.dev` over HTTPS. Files are not retained beyond the duration of a single request.

<!-- ci-smoke-test: 2026-05-19 grace-review workflow -->
<!-- retry: llm-review vendored -->
