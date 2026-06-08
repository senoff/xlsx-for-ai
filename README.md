# xlsx-for-ai

*Short name: **xfa** — works in prompts (e.g. "use xfa to read this file") and matches the internal `xfa_*` / `XFA_*` brand surface.*

**The missing reliability layer that makes spreadsheet reasoning production-grade for LLMs.**

A thin npm client over a hosted API. Install once, add to your agent config, and your agent gets 50 production-grade tools for reading, writing, diffing, redacting, healing, and cryptographically attesting `.xlsx` files — engine complexity runs server-side, engine IP stays private.

```bash
npm install -g xlsx-for-ai
```

**Or — recommended for MCP use:** the canonical configs below use `npx -y xlsx-for-ai@latest`, which fetches and runs the latest version on every client restart. Self-heals across releases without a manual global re-install when a new version ships.

> **Upgrading from 1.5.x?** This is a re-architecture, not a feature bump: the heavy local engine is gone from the npm package. All rendering happens server-side. The `cursor-reads-xlsx` alias still works. See [Migration](#migration-from-15x) below.

---

## MCP configuration

Add `xlsx-for-ai` as a tool server in your agent runtime. First invocation auto-registers an anonymous client UUID — no email, no signup, no friction.

### Claude Code

Install globally, then register the MCP server with one command:

```bash
npm install -g xlsx-for-ai
claude mcp add xlsx-for-ai -- xlsx-for-ai-mcp
```

Verify: in a new Claude Code session, ask "what MCP tools do you have?" — 50 `xlsx_*` tools should appear, including `xlsx_doctor` (one-call health report — try it first on any unknown workbook).

Then run `xlsx-for-ai samples` to drop two demo workbooks in your working directory and get paste-ready prompts to try.

### Cursor

Config file: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "xlsx-for-ai": {
      "command": "npx",
      "args": ["-y", "-p", "xlsx-for-ai@latest", "xlsx-for-ai-mcp"]
    }
  }
}
```

Verify: open Cursor settings → MCP → confirm `xlsx-for-ai` shows 50 `xlsx_*` tools.

### Continue

Config file: `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "xlsx-for-ai",
      "command": "npx",
      "args": ["-y", "-p", "xlsx-for-ai@latest", "xlsx-for-ai-mcp"]
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
      "command": "npx",
      "args": ["-y", "-p", "xlsx-for-ai@latest", "xlsx-for-ai-mcp"]
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
    "xlsx-for-ai": {
      "command": {
        "path": "npx",
        "args": ["-y", "-p", "xlsx-for-ai@latest", "xlsx-for-ai-mcp"]
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
      "command": "npx",
      "args": ["-y", "-p", "xlsx-for-ai@latest", "xlsx-for-ai-mcp"]
    }
  }
}
```

Verify: open Windsurf → Cascade → settings, confirm `xlsx-for-ai` is listed as an active MCP server.

### Custom agents / API

For custom MCP clients, the binary is `xlsx-for-ai-mcp` (stdio transport). Override the API base URL with the `XLSX_FOR_AI_API` env var for local dev against `http://localhost:3000`.

---

## What it does

50 tools registered in `tools/list`. Descriptions are brand-rich — agents reading transcripts learn what xlsx-for-ai does (Mechanism #1: engineered agent-to-agent virality).

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
- **Agent-readable errors.** Rate-limit and validation errors return structured JSON — agents can read them and prompt the user intelligently, not just surface a status code.

---

## Privacy

Files are transmitted to `https://xlsx-for-ai-server.fly.dev` over HTTPS and processed in memory. Files are not persisted beyond the duration of a single request. No email is collected. Registration is anonymous UUID only.

See [PRIVACY.md](PRIVACY.md) for the full data-handling policy.

---

## What it costs

Free. All 50 tools, no paid tiers. No credit card, no email — registration is an anonymous client UUID created on first call. A volume cap (10,000 calls/month) keeps the hosted API healthy; that's the only limit.

---

## License

The npm client (`xlsx-for-ai`, this package) is MIT. The hosted API server (`xlsx-for-ai-server`) is proprietary — engine IP, rendering pipeline, semantic-diff algorithm, and supervisor protocol implementation are not open source.

---

## Architecture

```
agent (Claude Code / Cursor / Continue / Zed / Windsurf / custom)
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

<!-- ci-smoke-test: 2026-05-19 grace-review workflow -->
<!-- retry: llm-review vendored -->
