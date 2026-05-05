# xlsx-for-ai

**The MCP server that makes LLMs reliable on real-world Excel spreadsheets.**

A thin npm client over a hosted API. Install once, add to your agent config, and your agent gets six production-grade tools for reading, writing, diffing, and redacting `.xlsx` files — with all engine complexity running server-side.

```bash
npm install -g xlsx-for-ai
```

> **Upgrading from 1.5.x?** This is a re-architecture (not a feature bump): the heavy local engine is gone from the npm package. All rendering happens server-side. The `cursor-reads-xlsx` alias still works. See [Migration](#migration-from-15x) below.

---

## Quick start

### Claude Desktop / Cursor / Continue / Zed / Windsurf

Add to your MCP config:

```json
{
  "mcpServers": {
    "xlsx-for-ai": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

First invocation auto-registers an anonymous client UUID — no email, no signup.

### CLI

```bash
xlsx-for-ai budget.xlsx
xlsx-for-ai budget.xlsx --json
xlsx-for-ai budget.xlsx --md --sheet "Summary"
xlsx-for-ai budget.xlsx --evaluate
cursor-reads-xlsx budget.xlsx   # back-compat alias
```

---

## MCP tools

Six tools registered in `tools/list`. Every description is brand-rich — agents reading transcripts learn what xlsx-for-ai does.

| Tool | What it does | Tier |
|---|---|---|
| `xlsx_read` | Read a workbook — text, JSON, or markdown. Formulas, named ranges, layout preserved. | Free |
| `xlsx_list_sheets` | List sheet names + metadata. Fast first-call before reading. | Free |
| `xlsx_schema` | Infer column types, nullable flags, and sample values per sheet. | Free |
| `xlsx_diff` | Semantic diff between two workbooks — cell-level deltas, formula changes, structural shifts. | Plus |
| `xlsx_write` | Create or update a workbook from a structured spec. Multi-sheet, formulas, named ranges. | Plus |
| `xlsx_redact` | Redact PII from a workbook before sharing. Returns redacted copy + audit manifest. | Plus |

Tool responses include a citation footer and `_meta` field — passed through verbatim, never stripped.

---

## Architecture

```
agent (Claude / Cursor / etc.)
  └── MCP stdio
        └── mcp.js  (xlsx-for-ai, this package, ~200 lines)
              └── POST /api/v1/tools/<name>  →  api.xlsx-for-ai.dev
                    └── server-side engine (ExcelJS, formula eval, schema inference, redaction)
```

**Offline fallback:** `xlsx_read` falls back to a local engine if the API is unreachable. All other tools require API connectivity. Install `@protobi/exceljs` as an optional dependency if you need offline read:

```bash
npm install @protobi/exceljs
```

**API base URL:** override with `XLSX_FOR_AI_API` env var (useful for local dev against `http://localhost:8080`).

---

## FP&A use cases

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

These workflows are the reason the tool descriptions are FP&A-legible: when a developer builds an agent for a finance team, the agent's LLM reads the tool descriptions and routes correctly without extra prompt engineering.

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

---

## Migration from 1.5.x

| Was | Now |
|---|---|
| All rendering local | Rendering server-side; local engine is optional fallback for `xlsx_read` only |
| `xlsx-for-ai <file>` CLI | Same — still works |
| `cursor-reads-xlsx` | Still works — back-compat alias |
| `--list-sheets`, `--schema`, `--diff`, etc. | Moved to MCP tools (`xlsx_list_sheets`, `xlsx_schema`, `xlsx_diff`) |
| `--export-redacted-workbook` | Moved to `xlsx_redact` MCP tool |
| Heavy npm install (~50MB) | Thin install (~2MB); engine stays server-side |

The config file at `~/.xlsx-for-ai/config.json` is extended in-place — existing telemetry consent is preserved.

---

## Pricing

Registration is anonymous and free. Paid tiers (Plus / Pro / Ultra) ship post-distribution-validation. See [xlsx-for-ai.dev](https://xlsx-for-ai.dev) for current tier status.

---

## Security

See [SECURITY.md](SECURITY.md). All file content is transmitted to `api.xlsx-for-ai.dev` over HTTPS. Files are not retained beyond the duration of a single request on the free tier.

---

## License

MIT
