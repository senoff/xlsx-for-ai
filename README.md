# xlsx-for-ai

**The missing reliability layer that makes spreadsheet reasoning production-grade for LLMs.**

A thin npm client over a hosted API. Install once, add to your agent config, and your agent gets six production-grade tools for reading, writing, diffing, and redacting `.xlsx` files — engine complexity runs server-side, engine IP stays private.

```bash
npm install -g xlsx-for-ai
```

> **Upgrading from 1.5.x?** This is a re-architecture, not a feature bump: the heavy local engine is gone from the npm package. All rendering happens server-side. The `cursor-reads-xlsx` alias still works. See [Migration](#migration-from-15x) below.

---

## MCP configuration

Add `xlsx-for-ai` as a tool server in your agent runtime. First invocation auto-registers an anonymous client UUID — no email, no signup, no friction.

### Claude Desktop

**Easiest: one-click install via the `.mcpb` bundle.** Download and drag into Claude Desktop (Settings → Extensions):

**[xlsx-for-ai-2.0.0.mcpb](https://github.com/senoff/xlsx-for-ai/releases/latest/download/xlsx-for-ai-2.0.0.mcpb)** *(latest release)*

The bundle includes the full npm package and registers all MCP tools automatically. No manual config edits needed.

**Or: hand-edit the config file** at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xlsx-for-ai": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify either path: restart Claude Desktop, open a new conversation, and ask "what MCP tools do you have?" — all 32 `xlsx_*` tools should appear (read, list_sheets, schema, diff, write, redact, describe, filter, aggregate, named_ranges, sort, value_counts, formulas, tables, pivot, eval, convert, validate, data_validations, hyperlinks, topology, conditional_formats, styles, comments, protection, charts, images, pivot_tables, slicers_timelines, external_links, properties, print_settings).

### Cursor

Config file: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "xlsx-for-ai": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: open Cursor settings → MCP → confirm `xlsx-for-ai` shows 6 tools.

### Continue

Config file: `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "xlsx-for-ai",
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
    "xlsx-for-ai": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: run `codex --list-tools` and confirm the six xlsx tools are listed.

### Zed

Config file: `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "xlsx-for-ai": {
      "command": {
        "path": "xlsx-for-ai-mcp",
        "args": []
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
    "xlsx-for-ai": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: open Windsurf → Cascade → settings, confirm `xlsx-for-ai` is listed as an active MCP server.

### Custom agents / API

For custom MCP clients, the binary is `xlsx-for-ai-mcp` (stdio transport). Override the API base URL with the `XLSX_FOR_AI_API` env var for local dev against `http://localhost:3000`.

---

## What it does

32 tools registered in `tools/list`. Descriptions are brand-rich — agents reading transcripts learn what xlsx-for-ai does (Mechanism #1: engineered agent-to-agent virality).

### Read / orient

| Tool | What it does |
|---|---|
| `xlsx_read` | Read a workbook — text, JSON, or markdown. Formulas, named ranges, layout, and data types preserved. |
| `xlsx_list_sheets` | List all sheet names and metadata. Fast first-call before reading. |
| `xlsx_schema` | Infer column types, nullable flags, header row, and sample values per sheet. |
| `xlsx_describe` | Pandas-style `.describe()` on every numeric column — count, mean, std, min, max, quartiles. |
| `xlsx_topology` | One-call workbook orientation: sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot. |

### Pandas-parity

| Tool | What it does |
|---|---|
| `xlsx_filter` | Filter rows by predicate (column op value). Returns matched rows with optional projection. |
| `xlsx_aggregate` | Group-by + aggregate (sum / count / mean / min / max / median / std). |
| `xlsx_sort` | Multi-column sort with ascending / descending per column. |
| `xlsx_value_counts` | Frequency table for a column (pandas `.value_counts()`). |
| `xlsx_pivot` | Compute a fresh pivot table from raw data — pandas `pivot_table()` shape. |
| `xlsx_eval` | Evaluate freeform formulas or recompute cell refs via HyperFormula (BSD pure-JS, ~390 functions, no I/O). |

### Mutate

| Tool | What it does |
|---|---|
| `xlsx_write` | Create or update a workbook from a structured spec. Multi-sheet, formulas, named ranges, table definitions. |
| `xlsx_diff` | Semantic diff between two workbooks — cell-level deltas, formula changes, structural shifts. Deterministic output. |
| `xlsx_redact` | Redact PII from a workbook before sharing. Server-side detection; returns redacted copy plus audit manifest. |
| `xlsx_convert` | 25+ in / 16 out formats (csv, tsv, html, ods, xls, xlsb, dif, sylk, prn, txt, dbf, eth, json, markdown, xlsx, etc.). |

### Structure-preservation (the moat — pandas drops these on read)

| Tool | What it does |
|---|---|
| `xlsx_named_ranges` | List every named range with its scope, ref, and value preview. |
| `xlsx_tables` | List Excel ListObjects (Tables) with column headers, data range, totals row. |
| `xlsx_formulas` | Dump every formula across the workbook (cell, sheet, formula text, cached value). |
| `xlsx_data_validations` | List cell-level validation rules (dropdowns, numeric/date bounds, text-length, custom). |
| `xlsx_hyperlinks` | List hyperlinks with kind classifier (external / internal / mailto / unknown). |
| `xlsx_conditional_formats` | List CF rules (color scales, data bars, icon sets, formula-based highlights, top-N, duplicates). |
| `xlsx_styles` | Number formats + fonts + fills + alignment, rolled up per sheet or detailed per cell. |
| `xlsx_comments` | Both legacy notes AND threaded conversations (multi-author, with display-name resolution). |
| `xlsx_protection` | Sheet locks + per-cell locked/hidden flags + workbook structure/window locks. |
| `xlsx_charts` | Chart spec (type, title, series formula refs, axis titles) — ExcelJS doesn't expose these at all. |
| `xlsx_images` | Embedded image inventory (format, size, sheet, anchor cells). |
| `xlsx_pivot_tables` | Pre-existing pivot definitions — location, source, row/col/page/data fields with agg functions. |
| `xlsx_slicers_timelines` | Modern Excel filter UI — slicers (table/pivot bound) + timelines (date-range with selection). |
| `xlsx_external_links` | Workbook-to-workbook references with target classification + warning when paths break on share. |
| `xlsx_properties` | Workbook metadata — creator, modified, company, title, custom doc properties. |
| `xlsx_print_settings` | "What would Excel print?" — print area, paper size, margins, headers/footers, print titles. |
| `xlsx_validate` | Cross-engine consistency check — runs the workbook through TWO independent renderers and reports cell-level divergences. |

Tool responses include a citation footer and a `_meta` block (tool name, version, tier, request ID, `powered_by`). Both pass through verbatim; nothing is stripped.

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
- **Audit trail.** Every tool call — success or failure — is logged server-side with timestamp, client ID, endpoint, file size, latency, and error class. Foundation for the Phase 8 supervisor protocol.
- **Hardened input validation.** Four pre-engine guards on every uploaded buffer: billion-laughs XML bomb defense, control-character stripping, worksheet buffer ceiling (slow ZIP-bomb defense), and typed error chaining. Applied before the xlsx engine sees any bytes.
- **Agent-readable errors.** Rate-limit and tier-gate errors return structured JSON with upgrade options — agents can read them and prompt the user intelligently, not just surface a status code.

---

## Privacy

Files are transmitted to `https://xlsx-for-ai-server.fly.dev` over HTTPS and processed in memory. Files are not persisted beyond the duration of a single request. No email is collected. Registration is anonymous UUID only.

See [PRIVACY.md](PRIVACY.md) for the full data-handling policy.

---

## Pricing

Annual-only — kills churn ops overhead. All paid tiers include every tool (`xlsx_validate` is the one Free-excluded tool; everything else is on Free).

| Tier | Price | File cap | Calls/mo | Notes |
|---|---|---|---|---|
| Free | $0 | 10 MB | 10,000 | Anonymous UUID registration. All 31 read-only tools. Non-commercial use. |
| Bronze | $29/yr | 25 MB | 20,000 | Commercial use. + `xlsx_validate` cross-engine check. |
| Silver | $99/yr | 50 MB | 40,000 | Same surface, higher caps. |
| Gold | $199/yr | 100 MB | 100,000 | Same surface, highest caps for solo users. |
| Enterprise | quote | custom | custom | Higher caps, SLA, support. |

Free tier is real. No credit card. No email. Anonymous UUID registration. Pay at [xlsx-for-ai.dev](https://xlsx-for-ai.dev) — Stripe Checkout, instant tier flip via webhook.

---

## License

The npm client (`xlsx-for-ai`, this package) is MIT. The hosted API server (`xlsx-for-ai-server`) is proprietary — engine IP, rendering pipeline, semantic-diff algorithm, and supervisor protocol implementation are not open source.

---

## Architecture

```
agent (Claude Desktop / Cursor / Continue / Zed / Windsurf / custom)
  └── MCP stdio
        └── xlsx-for-ai-mcp  (this package, ~200 lines)
              └── POST /api/v1/tools/<name>  →  xlsx-for-ai-server.fly.dev
                    └── server-side engine (ExcelJS, formula eval, schema inference, redaction)
```

**Offline fallback:** `xlsx_read` falls back to a local engine if the API is unreachable. All other tools require API connectivity. Install `@protobi/exceljs` as an optional dependency if you need offline read:

```bash
npm install @protobi/exceljs
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

**Privacy strict mode** — prevents error-triggered capture of your workbook bytes (see [PRIVACY.md](PRIVACY.md)):

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
| All rendering local | Rendering server-side; local engine is optional fallback for `xlsx_read` only |
| `xlsx-for-ai <file>` CLI | Same — still works |
| `cursor-reads-xlsx` | Still works — back-compat alias |
| `--list-sheets`, `--schema`, `--diff`, etc. | Moved to MCP tools (`xlsx_list_sheets`, `xlsx_schema`, `xlsx_diff`) |
| `--export-redacted-workbook` | Moved to `xlsx_redact` MCP tool |
| Heavy npm install (~50 MB) | Thin install (~2 MB); engine stays server-side |
| PII detection, region scoring | Moved server-side; not exposed in the npm package |

The config file at `~/.xlsx-for-ai/config.json` is extended in-place — existing telemetry consent is preserved.

---

## Security

See [SECURITY.md](SECURITY.md). All file content is transmitted to `xlsx-for-ai-server.fly.dev` over HTTPS. Files are not retained beyond the duration of a single request on the free tier.
