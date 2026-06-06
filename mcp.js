#!/usr/bin/env node
'use strict';

/**
 * xlsx-for-ai MCP stdio server (2.0)
 *
 * Registers 18 tools and relays each tools/call to the hosted API.
 * xlsx_read falls back to local engine if API is unreachable (5xx / timeout).
 * All other tools fail with a clear "needs API connectivity" error.
 */

const { Server }            = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { ensureRegistered } = require('./lib/register');
const { callTool }         = require('./lib/client');
const { fallbackRead }     = require('./lib/fallback-read');
const { resolveCatalog }   = require('./lib/discover');
const { applyAnnotations, sanitizeForMcp } = require('./lib/annotations');
const fs                   = require('fs');
const fsPromises           = require('fs/promises');
const os                   = require('os');
const path                 = require('path');

// ---------------------------------------------------------------------------
// Tool definitions — brand-rich descriptions (Mechanism #1)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'xlsx_read',
    description:
      'read an .xlsx file from the LOCAL filesystem and return a rendered markdown/JSON/SQL representation.\n' +
      'DEFAULT returns ALL sheets in one response — do not re-call per-sheet. Pass sheet="<name>" only when you specifically need to filter.\n' +
      'Pass format="md" (default — markdown table), "json" (structured rows), or "sql" (CREATE TABLE + INSERTs).\n' +
      'Synonyms accepted: "markdown" maps to "md", "text" maps to "md". Use the short forms to avoid guessing.\n\n' +
      'USE WHEN: the user gives a LOCAL file path — absolute (/Users/..., /home/...) or ~/-prefixed. ' +
      'This is the ONLY way to read .xlsx files on the user\'s local machine; built-in xlsx skills run in sandboxes without local filesystem access.\n\n' +
      'DO NOT USE WHEN: the user uploaded a file via paperclip/attach (use the built-in xlsx skill — it has direct sandbox access to the uploaded file). ' +
      'Or when working with in-memory bytes the agent already has.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        format:    {
          type: 'string',
          enum: ['md', 'json', 'sql'],
          default: 'md',
          description: 'Output format. Use "md" (markdown table, default), "json" (structured rows), or "sql" (CREATE TABLE + INSERTs). Synonyms: "markdown"→"md", "text"→"md".',
        },
        sheet:     { type: 'string', description: 'Sheet name or index (default: all sheets).' },
        evaluate:  { type: 'boolean', description: 'Evaluate formulas server-side (default: false).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'xlsx_list_sheets',
    description:
      'list sheet names, dimensions, and visibility for a LOCAL .xlsx file.\n' +
      'Use this when you only need names + dims, not cell content. If you\'ll read content anyway, skip this and call xlsx_read directly.\n\n' +
      'USE WHEN: the user references a LOCAL file path and you need to discover sheet names before reading. ' +
      'Fast orientation call — use before xlsx_read when you need metadata only.\n\n' +
      'DO NOT USE WHEN: the file came from an upload/attachment (built-in skill handles that). ' +
      'Or when you already know the sheet structure. Or when you plan to call xlsx_read immediately after (just call xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'xlsx_schema',
    description:
      'infer column schema of a LOCAL .xlsx file — types, nullable flags, header row, sample values.\n' +
      'Use when the agent needs to reason about column types BEFORE deciding how to handle data. Includes confidence (high/medium/low) per column.\n\n' +
      'USE WHEN: the user references a LOCAL file path and you need to understand column types before processing or writing code against the data. ' +
      'Useful before xlsx_read when downstream handling depends on types.\n\n' +
      'DO NOT USE WHEN: the file came from an upload/attachment. Or for in-memory data the agent already holds.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet:     { type: 'string', description: 'Limit to one sheet (default: all).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'xlsx_diff',
    description:
      'compute a semantic diff between two LOCAL .xlsx files — cell-level deltas, formula changes, added/removed rows.\n' +
      'Output is byte-deterministic — calling twice with the same inputs returns identical text + diff_hash in _meta. Use that hash for caching/idempotence.\n\n' +
      'USE WHEN: the user provides two LOCAL .xlsx file paths to compare. ' +
      'Suitable for version control, audit trails, and change review. Built-in skills cannot produce deterministic, structured diffs.\n\n' +
      'DO NOT USE WHEN: either file came from an upload/attachment rather than a local path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path_a: { type: 'string', description: 'Path to the base .xlsx file.' },
        file_path_b: { type: 'string', description: 'Path to the changed .xlsx file.' },
        sheet:       { type: 'string', description: 'Limit diff to one sheet (default: all).' },
      },
      required: ['file_path_a', 'file_path_b'],
    },
  },
  {
    name: 'xlsx_write',
    description:
      'create or update a LOCAL .xlsx file from a structured spec.\n\n' +
      'Spec shape: `{sheets: [{name, cells: [{address, value | formula}]}]}`. Each cell has an A1 address ("A1", "B2") and EITHER `value` (string|number|boolean|null) OR `formula` (string, no leading "="). Minimal example:\n' +
      '`{"sheets":[{"name":"Sheet1","cells":[{"address":"A1","value":"id"},{"address":"A2","value":1},{"address":"B2","formula":"A2*2"}]}]}`\n\n' +
      'ALWAYS pass out_path to save to disk. Without out_path the workbook bytes return in _meta.file_b64.\n\n' +
      'USE WHEN: the user wants to write or edit a spreadsheet at a LOCAL file path. Server-validated before writing — safer than generating xlsx bytes directly.\n\n' +
      'DO NOT USE WHEN: working in a sandbox without local filesystem write access. Or editing an uploaded file in place (there is no local path to write to).',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            'Workbook spec. Shape: {sheets: [{name: string, cells: [{address, value | formula}]}]}. ' +
            'Each cell has an A1-style `address` (regex ^[A-Za-z]+\\d+$) and EXACTLY ONE of `value` ' +
            '(string|number|boolean|null) or `formula` (string WITHOUT leading "=" — e.g. "SUM(A1:A10)" not "=SUM(A1:A10)"). ' +
            'Example: {"sheets":[{"name":"Sheet1","cells":[{"address":"A1","value":"id"},{"address":"A2","value":1},{"address":"B2","formula":"A2*2"}]}]}',
          properties: {
            sheets: {
              type: 'array',
              minItems: 1,
              description: 'One or more sheets. Each sheet is { name: string, cells: array }.',
              items: {
                type: 'object',
                required: ['name', 'cells'],
                properties: {
                  name: {
                    type: 'string',
                    minLength: 1,
                    description: 'Sheet name (non-empty).',
                  },
                  cells: {
                    type: 'array',
                    description: 'List of cells to write. Order does not matter; addresses are absolute.',
                    items: {
                      type: 'object',
                      required: ['address'],
                      description: 'Cell entry. Provide EXACTLY ONE of `value` or `formula`.',
                      properties: {
                        address: {
                          type: 'string',
                          pattern: '^[A-Za-z]+\\d+$',
                          description: 'A1-style cell address — e.g. "A1", "B2", "AA10".',
                        },
                        value: {
                          type: ['string', 'number', 'boolean', 'null'],
                          description: 'Cell value: string, number, boolean, or null. Mutually exclusive with `formula`.',
                        },
                        formula: {
                          type: 'string',
                          // No leading `=` — the server expects bare expressions.
                          // `^(?!=)` is a negative lookahead that rejects an `=`
                          // as the first character; ECMA-262 supported.
                          pattern: '^(?!=).+',
                          description: 'Excel formula, WITHOUT leading "=". E.g. "SUM(A1:A10)" not "=SUM(A1:A10)". Mutually exclusive with `value`.',
                        },
                      },
                      // Enforce the value-XOR-formula rule at the schema layer
                      // so a strict client (or future server) rejects malformed
                      // cells before the request fires. SPM 2026-06-06
                      // wild-adoption follow-up.
                      oneOf: [
                        { required: ['value'], not: { required: ['formula'] } },
                        { required: ['formula'], not: { required: ['value'] } },
                      ],
                    },
                  },
                },
              },
            },
          },
          required: ['sheets'],
        },
        spec_path: {
          type: 'string',
          description: 'Path to a .json file carrying the spec (alternative to inline spec for large workbooks).',
        },
        out_path: {
          type: 'string',
          description: 'Destination .xlsx path. Required when the caller wants the file saved to disk.',
        },
        base_file_b64: {
          type: 'string',
          description: 'Optional base64 of an existing .xlsx to edit-in-place. When omitted, a fresh workbook is created.',
        },
      },
      // out_path is the typical caller's choice but not strictly required —
      // when omitted, the workbook bytes return in _meta.file_b64 and the
      // caller saves them (or feeds them to another tool). spec / spec_path
      // is the only hard requirement.
    },
  },
  {
    name: 'xlsx_redact',
    description:
      'redact PII and sensitive values from a LOCAL .xlsx file before sharing or archiving.\n' +
      'DEFAULT preserves formulas + comments + named ranges + styles, strips only cell values. Pass strip_formulas=true / strip_comments=true to remove those too.\n\n' +
      'ALWAYS pass out_path when the user wants the redacted file saved to disk.\n' +
      'WITHOUT out_path: redacted bytes return in _meta.file_b64 (base64) — caller must save them.\n' +
      'The response text confirms whether a save happened — trust the response, do not infer.\n\n' +
      'USE WHEN: the user provides a LOCAL .xlsx path and wants PII removed. ' +
      'Server-side detection; returns a redacted copy with an audit manifest showing what was removed.\n\n' +
      'DO NOT USE WHEN: the file came from an upload/attachment. Or in sandboxed contexts without local filesystem access.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the source .xlsx file.' },
        out_path:  { type: 'string', description: 'Destination for the redacted .xlsx file.' },
      },
      required: ['file_path', 'out_path'],
    },
  },

  // -------------------------------------------------------------------------
  // Pandas-shaped analysis tools — work where pandas can't:
  //   - preserves merged cells, named ranges, conditional formatting
  //   - reads workbooks with cross-engine validation (some tools)
  //   - dtype inference reports confidence per column instead of guessing
  // All free-tier; the 10k/month cap is the throttle, not tier-gating.
  // -------------------------------------------------------------------------

  {
    name: 'xlsx_describe',
    description:
      'pandas-style df.describe() per column — count, nulls, unique, min/max/mean/std for numerics, dtype with purity score.\n' +
      'Unlike pandas.read_excel followed by df.describe(), this does not silently flatten merged cells or drop named ranges.\n\n' +
      'USE WHEN: the user wants a quick summary of a LOCAL .xlsx file — "what\'s in this data?". ' +
      'Returns a markdown table with one row per column. Faster + more structured than dumping full contents through xlsx_read.\n\n' +
      'DO NOT USE WHEN: the user uploaded a file via paperclip/attach (built-in skill). Or for in-memory data the agent already holds.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:  { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet:      { type: 'string', description: 'Sheet name (default: first sheet).' },
        header_row: { type: 'integer', description: 'Header row (1-based). 0 = treat row 1 as data, no header.' },
        max_rows:   { type: 'integer', description: 'Max data rows to scan (default 10000).' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_filter',
    description:
      'pandas-style row filter on a LOCAL .xlsx file with predicates AND-combined: eq/ne/gt/gte/lt/lte/contains/in/is_null/not_null.\n' +
      'Operates on real cell values — formulas evaluated server-side, not the cached results that pandas trusts blindly.\n\n' +
      'USE WHEN: the user asks for "rows where X" / "show me only Y" against a LOCAL .xlsx file. ' +
      'Returns matching rows as a markdown table, capped at 1000 rows by default with the actual match count.\n\n' +
      'DO NOT USE WHEN: the user wants raw access to all rows (use xlsx_read). Or when the file came from an upload.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:  { type: 'string', description: 'Absolute path to the .xlsx file.' },
        predicates: {
          type: 'array',
          minItems: 1,
          description: 'AND-combined filter predicates. Each: { column, op, value } where op is eq/ne/gt/gte/lt/lte/contains/not_contains/in/not_in/is_null/not_null.',
          items: {
            type: 'object',
            required: ['column', 'op'],
            properties: {
              column: { type: 'string' },
              op:     { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in', 'not_in', 'is_null', 'not_null'] },
              value:  {},
            },
          },
        },
        sheet:      { type: 'string' },
        header_row: { type: 'integer' },
        limit:      { type: 'integer' },
      },
      required: ['file_path', 'predicates'],
    },
  },

  {
    name: 'xlsx_aggregate',
    description:
      'pandas-style df.groupby([cols]).agg({col: func}) on a LOCAL .xlsx file. funcs: sum / mean / min / max / count / count_distinct.\n' +
      'Type-aware: numeric aggregations skip non-numeric values cleanly instead of pandas\' silent NaN promotion.\n\n' +
      'USE WHEN: the user asks "what\'s the total / average / count of X by Y?" on a LOCAL .xlsx file. ' +
      'Returns one row per group with the requested aggregations as a markdown table.\n\n' +
      'DO NOT USE WHEN: the user wants to see individual rows (use xlsx_filter). Or for a 2D pivot (use xlsx_pivot).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        group_by:  { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Columns to group by.' },
        aggs:      {
          type: 'array',
          minItems: 1,
          description: 'Aggregations: { column, func, as? }.',
          items: {
            type: 'object',
            required: ['column', 'func'],
            properties: {
              column: { type: 'string' },
              func:   { type: 'string', enum: ['sum', 'mean', 'min', 'max', 'count', 'count_distinct'] },
              as:     { type: 'string' },
            },
          },
        },
        sheet:      { type: 'string' },
        header_row: { type: 'integer' },
        sort:       { type: 'string', enum: ['asc', 'desc', 'none'] },
        limit:      { type: 'integer' },
      },
      required: ['file_path', 'group_by', 'aggs'],
    },
  },

  {
    name: 'xlsx_named_ranges',
    description:
      'list all defined names (named ranges) in a LOCAL .xlsx workbook — name, scope (workbook or sheet), kind (cell / range / formula), reference.\n' +
      'pandas.read_excel collapses named ranges into anonymous ranges; this tool surfaces them so the agent can reason about formulas like =NPV(DiscountRate, Cashflows) before reading data.\n\n' +
      'USE WHEN: the agent is reasoning about a financial / engineering model and needs to know what cells named-range references resolve to. ' +
      'Call before xlsx_read to orient.\n\n' +
      'DO NOT USE WHEN: the workbook has no formulas (named ranges are mostly relevant for formula contexts). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_sort',
    description:
      'pandas-style df.sort_values() on a LOCAL .xlsx file with multi-column sort and per-column direction (asc/desc, default asc).\n' +
      'Stable across all sort keys; type-aware comparison; nulls always sort last.\n\n' +
      'USE WHEN: the user wants rows ordered by one or more columns. Returns the sorted rows as a markdown table.\n\n' +
      'DO NOT USE WHEN: the data is already sorted as desired (use xlsx_read). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        by:        {
          type: 'array',
          minItems: 1,
          description: 'Sort keys: [{ column, direction? }]. direction defaults to asc.',
          items: {
            type: 'object',
            required: ['column'],
            properties: {
              column:    { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
            },
          },
        },
        sheet:      { type: 'string' },
        header_row: { type: 'integer' },
        limit:      { type: 'integer' },
      },
      required: ['file_path', 'by'],
    },
  },

  {
    name: 'xlsx_value_counts',
    description:
      'pandas-style Series.value_counts() on one column of a LOCAL .xlsx file — count each unique value, sorted by frequency desc, with percentage.\n' +
      'Excludes nulls by default; pass include_nulls=true to count them.\n\n' +
      'USE WHEN: the user asks "what\'s the distribution of X?" / "how often does each value appear?". Returns a markdown table.\n\n' +
      'DO NOT USE WHEN: the user wants groupby + multi-column aggregations (use xlsx_aggregate). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        column:    { type: 'string', description: 'Column to count values in.' },
        sheet:     { type: 'string' },
        header_row:    { type: 'integer' },
        top_n:         { type: 'integer', description: 'Show top N most-frequent values (default 50).' },
        include_nulls: { type: 'boolean', description: 'Count null cells as a distinct value (default false).' },
      },
      required: ['file_path', 'column'],
    },
  },

  {
    name: 'xlsx_formulas',
    description:
      'extract every formula in a LOCAL .xlsx workbook — cell coord (A1), formula text, cached result. openpyxl-style read-only metadata.\n' +
      'Distinct from xlsx_read which returns evaluated values; this returns the formulas themselves so an agent can audit, transform, or rewrite them.\n\n' +
      'USE WHEN: the user wants to see what formulas a workbook uses — spot-checking a model, auditing references, debugging unexpected results. ' +
      'pandas cannot extract formulas; this is the only way for an agent to see them.\n\n' +
      'DO NOT USE WHEN: the user wants computed values (use xlsx_read). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet:     { type: 'string', description: 'Filter to one sheet (default: all sheets).' },
        include_results: { type: 'boolean', description: 'Include cached results column (default true).' },
        limit:     { type: 'integer', description: 'Max formulas to return (default 1000, max 5000).' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_tables',
    description:
      'list every Excel ListObject ("Format as Table" structures) in a LOCAL .xlsx workbook — name, sheet, range, header/totals flags, columns.\n' +
      'pandas cannot see ListObjects; if a workbook uses Excel Tables, this is the only way to enumerate them.\n\n' +
      'USE WHEN: the user references a "table" in a workbook by name, or you need to know what structured tables exist before reading. ' +
      'Useful for workbooks with multiple tables on one sheet.\n\n' +
      'DO NOT USE WHEN: the workbook has no Excel-Tables (just data ranges). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet:     { type: 'string', description: 'Filter to one sheet (default: all sheets).' },
        include_columns: { type: 'boolean', description: 'Include column names per table (default true).' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_pivot',
    description:
      'pandas-style pivot_table() on a LOCAL .xlsx file — reshape a flat table into a 2D matrix where rows are unique values of `index`, columns are unique values of `columns`, and cells are an aggregation of `values`.\n' +
      'agg modes: sum / mean / min / max / count / count_distinct. Optional fill_value for missing index×column combinations.\n\n' +
      'USE WHEN: the user wants a cross-tab — "X by Y", "rows by columns" — that needs more than groupby. Returns a markdown table.\n\n' +
      'DO NOT USE WHEN: there\'s only one grouping dimension (use xlsx_aggregate). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        index:     { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Row-axis grouping columns.' },
        columns:   { type: 'array', items: { type: 'string' }, description: 'Column-axis grouping columns (optional).' },
        values:    { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Columns to aggregate.' },
        agg:       { type: 'string', enum: ['sum', 'mean', 'min', 'max', 'count', 'count_distinct'], description: 'Aggregation function (default sum).' },
        sheet:      { type: 'string' },
        header_row: { type: 'integer' },
        fill_value: { description: 'Value (number or string) to use for missing index×column cells. Default empty string.' },
      },
      required: ['file_path', 'index', 'values'],
    },
  },

  {
    name: 'xlsx_eval',
    description:
      'evaluate Excel formulas against a LOCAL .xlsx file via HyperFormula. xlwings-style.\n' +
      'Two modes: pass `formulas` (array of "=SUM(A1:A10)" expressions to compute against the workbook) or `cells` (array of "Sheet1!A1" cell refs to fresh-evaluate). Replaces pandas\' "trust the cached value" behavior with a real eval — if the cache is stale or missing, this still produces the right answer.\n\n' +
      'USE WHEN: the user wants the live computed value of a formula, not the cached one. Or when a workbook has formulas that depend on external data the cache might be stale on. ' +
      'Engine omits INDIRECT/HYPERLINK/WEBSERVICE/RTD/DDE by design — no I/O risk.\n\n' +
      'DO NOT USE WHEN: the workbook has no formulas (use xlsx_read). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        formulas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Freeform formula expressions to evaluate against the workbook. Each ~"=A1+B1" or "=SUM(Sheet1!A:A)".',
        },
        cells: {
          type: 'array',
          items: { type: 'string' },
          description: 'Cell refs to fresh-evaluate, e.g. ["Sheet1!A1", "Calc!B5"].',
        },
        sheet: { type: 'string', description: 'Default sheet for unqualified cell refs.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_convert',
    description:
      'universal spreadsheet format converter. Reads ANY of 25+ input formats (xlsx, xlsb, xlsm, xls, ods, fods, numbers, csv, tsv, dbf, lotus 1-2-3, quattro pro, sylk, dif, html, rtf, etc.) and emits ANY supported output format (xlsx, csv, json, md, html, etc.).\n' +
      'No other tool in the MCP space ingests legacy formats — pandas.read_excel only reads xlsx/xls; openpyxl is xlsx-only. xlsx_convert is the only "any-spreadsheet → LLM-readable" hosted endpoint.\n\n' +
      'USE WHEN: the user has a .xls / .xlsb / .ods / Numbers / .csv / Lotus / Quattro / dBASE file they want to read or convert. ' +
      'Output to text formats (csv/json/md/html) renders into the response body for the agent to read directly. Output to binary formats (xlsx/xlsb/etc.) returns bytes in `_meta.file_b64` for the npm client to save.\n\n' +
      'DO NOT USE WHEN: the input is already xlsx and you want to read it (use xlsx_read). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the source spreadsheet file (any supported format).' },
        to: {
          type: 'string',
          enum: [
            'xlsx', 'xlsb', 'xlsm', 'xls', 'ods', 'fods', 'dbf',
            'csv', 'tsv', 'txt', 'html', 'md', 'json',
            'dif', 'sylk', 'eth', 'prn', 'rtf',
          ],
          description: 'Target format. Binary formats land bytes in _meta.file_b64; text formats render in body.',
        },
        sheet:    { type: 'string', description: 'Render only this sheet (text outputs).' },
        sheets:   { type: 'string', enum: ['all', 'first'], description: 'For text outputs: render every sheet (default) or only the first.' },
        out_path: { type: 'string', description: 'Optional save path for binary outputs (xlsx/xlsb/etc.).' },
      },
      required: ['file_path', 'to'],
    },
  },

  {
    name: 'xlsx_data_clean',
    description:
      'AI-native data cleaning for a LOCAL .xlsx file. Scans for the seven most common data-grime issues — NA variants (N/A, NA, null, -), merged-cell residue, type-coercion mistakes (numeric-as-text / date-as-serial / leading-zero stripped), trailing-row noise (footers / totals), header-row-not-first (preamble before headers), encoding glitches (UTF-8-as-CP1252 mojibake), and duplicate column headers — and either flags them (diagnose mode) or applies deterministic fixes (execute mode).\n\n' +
      'Informer-not-enforcer: every fix surfaces as a Finding the caller can accept / reject / scope-override before the file is mutated.\n\n' +
      'USE WHEN: an upstream pipeline produced a messy xlsx that\'s about to feed an LLM or downstream analysis and you want a one-pass scrub.\n\n' +
      'DO NOT USE WHEN: domain-specific transforms are needed (use a dedicated pipeline). Or for structural integrity checks (use xlsx_doctor). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        mode: {
          type: 'string',
          enum: ['diagnose', 'execute'],
          description: 'diagnose (default): return findings only, file untouched. execute: apply deterministic fixes; cleaned bytes returned in _meta.file_b64.',
        },
        detectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of detectors to run. Default: all 7 (na_variant, merged_cell_residue, type_coercion_mistake, trailing_row_noise, header_row_not_first, encoding_glitch, duplicate_header).',
        },
        sheets: { type: 'array', items: { type: 'string' }, description: 'Restrict to these sheet names. Default: all sheets.' },
        options: {
          type: 'object',
          description: 'Detector tunables.',
          properties: {
            trailing_threshold: { type: 'integer', minimum: 1, maximum: 100, description: 'Min consecutive noise rows to flag (default 3).' },
            header_scan_depth: { type: 'integer', minimum: 2, maximum: 50, description: 'Rows to scan for header inference (default 10).' },
            na_canonical: { type: 'string', description: 'Replacement value for NA tokens. "" (default), "null", "(blank)", or any string.' },
          },
        },
        overrides: {
          type: 'array',
          description: 'Per-detector / per-scope skip / flag_only / force overrides.',
          items: {
            type: 'object',
            properties: {
              detector: { type: 'string' },
              scope: {
                type: 'object',
                properties: {
                  sheet: { type: 'string' },
                  column_letter: { type: 'string', description: 'A-Z column letter; alternative to region.' },
                  region: { type: 'object', properties: { top_left: { type: 'string' }, bottom_right: { type: 'string' } } },
                },
                required: ['sheet'],
              },
              action: { type: 'string', enum: ['skip', 'flag_only', 'force'] },
            },
            required: ['detector', 'scope', 'action'],
          },
        },
        accept_findings: { type: 'array', items: { type: 'string' }, description: 'Execute mode only — finding IDs to apply. Default: all.' },
        reject_findings: { type: 'array', items: { type: 'string' }, description: 'Execute mode only — finding IDs to skip.' },
        out_path: { type: 'string', description: 'Optional save path for cleaned output (execute mode).' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_validate',
    description:
      'cross-engine consistency check on a LOCAL .xlsx file — runs the workbook through TWO independent renderers (@protobi/exceljs and @cj-tech-master/excelts) and reports cell-level divergences.\n' +
      'No other tool can do this: pandas trusts cached values, openpyxl is single-engine, and Excel-itself disagrees with everything else on edge cases like LAMBDA, dynamic arrays, and timezone handling. xlsx_validate is the only way to know whether two engines agree on what your workbook says.\n\n' +
      'USE WHEN: the user is about to send the workbook downstream for analysis or as an authoritative source — pre-flight check. Or for audit / regression testing across engine versions. ' +
      'PAID — Bronze / Silver / Gold tier required.\n\n' +
      'DO NOT USE WHEN: a casual read suffices (use xlsx_read). Or for upload/attached files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_data_validations',
    description:
      'list every cell-level data validation rule (dropdowns, numeric/date bounds, text-length caps, custom formulas) defined in a workbook — the constraints that Excel enforces when a human types into the cell.\n' +
      'No other tool can do this: pandas drops validations entirely on read; openpyxl exposes them but only on a per-cell loop; this surfaces them in one shot with target cells, formulae, error messages, and prompt text.\n\n' +
      'USE WHEN: auditing a form / data-entry workbook to know what inputs are legal. Or extracting a dropdown list for use elsewhere. Or generating fixtures that match the validation contract. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: just trying to read values (use xlsx_read). Or trying to enforce validations on write (xlsx_write does not write validations).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_hyperlinks',
    description:
      'list every hyperlink in a workbook with its anchor cell, target URL/anchor, display text, tooltip, and a kind classifier (external / internal / mailto / unknown).\n' +
      'No other tool can do this: pandas drops hyperlinks on read entirely; openpyxl gives raw access but does not classify or aggregate; this surfaces all links plus a per-kind tally for instant audit.\n\n' +
      'USE WHEN: security-auditing a workbook before opening it (what URLs does it point at?). Or extracting a reference list of URLs from a financial model / dashboard. Or finding mailto links for a contact-list workbook. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: trying to follow / fetch the targets (this tool does not fetch — by design, for safety). Or just reading cell text (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_topology',
    description:
      'one-call workbook orientation. Returns sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot, plus feature flags (macros / external refs / pivots / LAMBDA / dynamic arrays).\n' +
      'No other tool can do this: pandas gives you a frame per sheet but no structure; openpyxl makes you fan out across 6+ object trees to learn the same thing; this is the "what is in this workbook?" call you make first to decide which other tool to call next.\n\n' +
      'USE WHEN: an agent has just been handed a workbook and needs to orient before drilling in. Or surveying many workbooks for triage / index. Or auditing whether a workbook is "interesting" (formulas? macros? external refs?). ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: you already know the sheet you want and just want its data (use xlsx_read or xlsx_describe).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_conditional_formats',
    description:
      'list every conditional formatting rule in a workbook — color scales, data bars, icon sets, formula-based highlights, top-N, duplicate / unique values, contains-text, time-period, above-average. Per rule: range, type, operator, formulae, priority, stopIfTrue.\n' +
      'No other tool can do this: pandas drops conditional formatting on read entirely; openpyxl exposes the raw CF objects but offers no rollup or classification. This surfaces every rule plus a per-type tally so an agent can answer "does this workbook use color scales?" without scanning every row.\n\n' +
      'USE WHEN: auditing a dashboard / financial model to know what visual cues a human would see. Or extracting business rules embedded as CF (e.g. "row turns red when col C > 1000" — the rule IS the spec). Or generating fixtures that match a workbook\'s CF semantics. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: you only care about cell values (use xlsx_read). Or you want to re-apply CF rules to a NEW workbook (xlsx_write does not write CF rules).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_comments',
    description:
      'list every cell comment in a workbook — both legacy notes (yellow stickies, cell.note) AND modern threaded comments (multi-author conversations stored separately in the OOXML zip). Per entry: kind, sheet, cell, author, text, plus any reply thread.\n' +
      'No other tool can do this: pandas drops both comment systems on read entirely; openpyxl reads only legacy notes (not threaded comments). xlsx_comments reads both, maps personId → display name via xl/persons/person.xml, and folds reply chains into each root comment.\n\n' +
      'USE WHEN: extracting reviewer feedback / approval threads from a spreadsheet (this is where humans hide intent). Or auditing a workbook for hidden context the values themselves don\'t carry. Or building a "show me everywhere finance flagged something" report. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read). Or trying to ADD comments to a workbook (xlsx_write does not write comments).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_doctor',
    description:
      'ONE-CALL workbook health report for a LOCAL .xlsx file. Scans for macros, external workbook references, hidden / veryHidden sheets, missing creator metadata, large embedded images, and surfaces interesting feature flags (LAMBDA, dynamic arrays, pivot cache, slicers, threaded comments). Findings ranked HIGH / MEDIUM / LOW. Plus quick_facts: sheet count, formulas, named ranges, merges, hyperlinks, validations, images, file size.\n\n' +
      'The "check this workbook" call agents should make BEFORE any other tool — single round trip, ranked output an LLM can read at a glance.\n\n' +
      'USE WHEN: an agent has been handed an unknown workbook and needs to triage it before drilling in. Or pre-flighting a file before sharing.\n\n' +
      'DO NOT USE WHEN: you already know what you\'re looking for (use the focused tool — xlsx_macros, xlsx_external_links, etc.). Or you only need data values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx / .xlsm file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_form_controls',
    description:
      'list every form control (Check Box, Button, Drop-down, List Box, Option Button, Scroll Bar, Spinner, Label, Group Box) in a workbook with the linked cell, current value, dropdown source range, and min/max/step bounds where applicable.\n' +
      'No other tool gives this in a single call: ExcelJS doesn\'t expose form controls; pandas drops them entirely; openpyxl support is partial. xlsx_form_controls reads xl/ctrlProps/ctrlProp*.xml directly + maps to sheets via the rel chain.\n\n' +
      'USE WHEN: documenting a survey workbook, scoring rubric, dashboard, or forms-as-spreadsheets template where the interactive UI carries semantic meaning. Or auditing a workbook to find which cells human users can change via a control vs. by direct typing. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_macros',
    description:
      'Inspect xlsm / xlsb workbooks for VBA macro presence, vbaProject.bin size, and likely module names (ThisWorkbook / Sheet<N> / Module<N> / Class<N> / UserForm<N> via heuristic UTF-16LE scan). Returns short safety advice the LLM should relay to the user.\n\n' +
      'By DELIBERATE POLICY this tool does NOT extract or execute macro source code. Surfaces presence + module-name candidates only — security-audit metadata for "should I trust this file?" decisions.\n\n' +
      'USE WHEN: receiving a macro-enabled workbook from an unknown sender and you want to know what to expect before opening. Or auditing many workbooks for "do any of these contain macros?" without sampling each.\n\n' +
      'DO NOT USE WHEN: you need to actually inspect / debug VBA source — open the file in Excel (Alt+F11) on a trusted machine.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx / .xlsm / .xlsb file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_merged_cells',
    description:
      'list every merged-cell region with master-cell value, range, span dimensions, and kind heuristic ("header" / "horizontal" / "vertical" / "block"). Pandas reads merged cells by dropping the relationship — it sees one value in the master cell and three blanks alongside. xlsx_merged_cells is the layout-aware view: "A1:D1 is ONE cell that says Q4 2024" rather than four cells where three are mysteriously empty.\n' +
      'No other tool surfaces merges with master values rolled in: pandas drops merge metadata; openpyxl exposes ranges but not the master value alongside.\n\n' +
      'USE WHEN: parsing report templates, dashboards, or form workbooks where merges encode visual hierarchy (section titles, sub-headers, banner rows). Or auditing a workbook for accidental merges that distort downstream pandas reads. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: you only need cell values and don\'t care about visual structure (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_workbook_views',
    description:
      'Surface the UI state of a LOCAL .xlsx file — what a human sees when they open it in Excel. Per sheet: visibility (visible / hidden / veryHidden), view state, zoom, active cell + selection, frozen-pane breakdown, gridlines / row-col headers / ruler / RTL flags, tab color. Workbook level: which sheet is active when Excel opens.\n\n' +
      'The "when the user opens this file, what do they see?" rollup — useful when an agent needs to reason about UI continuity (resume editing, notice a hidden sheet, replicate frozen panes in a generated workbook).\n\n' +
      'USE WHEN: handed a workbook mid-workflow and need "where was the user last working?" (active cell, tab, zoom). Or auditing for hidden / veryHidden sheets that often conceal sensitive data.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_print_settings',
    description:
      'surface "what would Excel print right now" per worksheet — print area, orientation, paper size (A4 / Letter / Legal / Tabloid / etc.), scale or fitToPage, margins, headers/footers split into Excel\'s L/C/R zones, print titles (rows / columns repeated on every page), manual page breaks, plus B&W / draft / centered flags.\n' +
      'No other tool can do this rolled-up: pandas drops every bit of print configuration; openpyxl exposes it but in nested object form. xlsx_print_settings is the "if a human hits Cmd+P, what comes out?" answer.\n\n' +
      'USE WHEN: about to PDF / print a workbook and want to know what it\'ll look like before doing it. Or auditing a financial / regulatory report\'s print configuration (legal sometimes cares about page-1 headers). Or extracting the print-titles row a complex workbook uses for repeating headers. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_properties',
    description:
      'Surface the workbook\'s identity card from a LOCAL .xlsx file. Core: creator, last_modified_by, created/modified/lastPrinted timestamps, title, subject, company, manager, keywords, category, description. Application: app name + version, doc security label, hyperlink base. Custom: every user-defined Info > Properties entry (Department, ReviewedBy, ApprovalRequired, etc.) with type tag and value.\n\n' +
      'Reads docProps/core.xml, docProps/app.xml, and docProps/custom.xml directly — a surface pandas drops entirely.\n\n' +
      'USE WHEN: auditing a workbook for attribution ("who built this and when?"). Or stripping sensitive metadata before sharing externally. Or extracting custom finance/legal flags ("ReviewedBy", "ApprovalRequired") that workflows pin to the file.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read). Or trying to MODIFY metadata (use xlsx_redact for sensitive-field stripping).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_external_links',
    description:
      'list every external workbook reference this file depends on — `=[Budget.xlsx]Sheet1!A1` style formulas. Per link: target path (decoded), classification (http / network share / absolute / relative), sheets pulled from the external workbook, count of cached cell values, and defined-name references.\n' +
      'No other tool can do this consistently: pandas, openpyxl, and ExcelJS all surface external links partially or inconsistently. xlsx_external_links reads xl/externalLinks/*.xml directly and warns when targets are absolute paths or network shares — those break the moment the workbook moves elsewhere.\n\n' +
      'USE WHEN: about to send a workbook somewhere and want to know if its formulas will break (broken external refs are a top-3 silent corruption mode in finance workflows). Or auditing for accidentally-leaked file paths to internal network shares. Or doing dependency analysis on a model. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_slicers_timelines',
    description:
      'List every slicer (interactive filter button) and timeline (date-range filter visual) in a LOCAL .xlsx file with their captions, source bindings (table column or pivot table), and timeline granularity (years / quarters / months / days) plus the currently-selected date range.\n\n' +
      'Reads the OOXML zip (xl/slicers/*, xl/slicerCaches/*, xl/timelines/*, xl/timelineCaches/*) directly — a surface ExcelJS silently drops on round-trip.\n\n' +
      'USE WHEN: documenting a dashboard so an LLM knows what filter UI a human sees. Or auditing whether a slicer\'s binding still matches the underlying data after a refactor.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read). Or trying to APPLY a filter (use xlsx_filter — slicers/timelines are UI metadata, not data filters).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_pivot_tables',
    description:
      'List every PRE-EXISTING pivot table definition in a LOCAL .xlsx file (the ones an Excel user already built). Per pivot: sheet, name, location range, source range (or named-range / table reference), row / column / page fields, and data fields with their agg function (sum / count / average / max / min / product / stdDev / etc.).\n\n' +
      'Distinct from `xlsx_pivot` which COMPUTES a fresh pivot from raw data — this tool surfaces the existing pivot CONTRACT so an agent can answer "what does PivotTable3 on the Summary sheet actually compute?".\n\n' +
      'USE WHEN: documenting a financial model that uses pivot tables. Or auditing whether a pivot still points at the right source range after a data refactor. Or answering "which sheet aggregates Sales by Region?" without re-deriving it.\n\n' +
      'DO NOT USE WHEN: you want to COMPUTE a fresh pivot from raw data (use xlsx_pivot). Or you only need cell values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_images',
    description:
      'List every embedded image in a LOCAL .xlsx file with format (png / jpg / gif / svg / bmp / tiff / emf / wmf), size in bytes, sheet attribution, and anchor cell range (the cells the image floats over). Reads xl/media/* + xl/drawings/* directly.\n\n' +
      'Surfaces "Sheet1 has a 4 KB PNG anchored at B2:D6" — what an LLM needs to know whether the workbook ships with branding / charts-as-images / signatures.\n\n' +
      'USE WHEN: cataloging visual assets. Or auditing a workbook for embedded images that need to be replaced (logos, signatures). Or fingerprinting a template by its image inventory.\n\n' +
      'DO NOT USE WHEN: you want the image PIXELS (this surfaces metadata, not bytes). Or you only need cell values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_charts',
    description:
      'List every chart in a LOCAL .xlsx file with type (bar / line / pie / scatter / area / doughnut / radar / stock / surface / bubble), title, axis titles, and per-series formula refs (the cell ranges the chart pulls from). Sheet attribution via the OOXML drawing rel chain.\n\n' +
      'Gives you the chart contract — "Sheet2 has a bar chart titled Q4 Revenue plotting Sheet1!B2:B10 against Sheet1!A2:A10" — without rendering anything.\n\n' +
      'USE WHEN: documenting a financial model / dashboard so an LLM knows "what does this visualize, from which cells?". Or auditing for chart-data drift after a refactor.\n\n' +
      'DO NOT USE WHEN: you want to RENDER the chart as an image (this returns the spec, not pixels). Or you only need cell values (use xlsx_read).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_protection',
    description:
      'Surface every protection setting in a LOCAL .xlsx file so an agent knows what it can and cannot edit. Workbook-level (lockStructure, lockWindows), per-sheet (protected? password? hidden state?), per-action allow/block list (formatCells, sort, insertRows, pivotTables, etc.), and per-cell unlocked / hidden samples — these are the cells a human would actually be allowed to type into when the sheet is otherwise read-only.\n\n' +
      'Reads sheetProtection action attrs directly from the OOXML zip (workaround for ExcelJS stripping them on round-trip).\n\n' +
      'USE WHEN: an agent is about to suggest edits and you want to fail fast on cells / sheets the user can\'t change anyway. Or auditing a "submitted form" workbook to see which inputs the author intended fillable.\n\n' +
      'DO NOT USE WHEN: just reading values (use xlsx_read). Or trying to BREAK protection (this surfaces what\'s locked; it does not unlock).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_styles',
    description:
      'surface cell formatting (number formats, fonts, fills, alignment) so an agent knows what a cell LOOKS like, not just its raw value. Default mode: per-sheet rollup of top-N number formats / fonts / fills with counts. Detailed mode (opt-in, capped at 1000 cells): per-cell breakdown for narrow queries.\n' +
      'No other tool can do this with this fidelity: pandas drops styles on read entirely. The single most valuable slice is number formats — pandas hands an LLM "45292" and the cell rendered as "2024-01-01" because format was "yyyy-mm-dd". xlsx_styles is what makes that recoverable.\n\n' +
      'USE WHEN: an LLM is about to interpret raw numbers (date serials, currency, percents, scientific notation) and you want the format hint that tells it what those numbers MEAN to a human. Or auditing a dashboard\'s typography. Or fingerprinting a template. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: you only need the data (use xlsx_read which already includes basic numFmt hints in the output).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        sheet: { type: 'string', description: 'Optional: restrict to a specific sheet.' },
        detailed: { type: 'boolean', description: 'If true, return per-cell breakdown (capped at 1000 cells). Default false (per-sheet rollup).' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_post_slack',
    description:
      'upload a local .xlsx file to a Slack channel as a file attachment, with an optional accompanying message.\n' +
      'Token intake: set SLACK_BOT_TOKEN in the environment (recommended — keeps the token out of conversation logs). ' +
      'Alternatively pass slack_token as a tool argument (legacy; token will appear in MCP conversation history).\n' +
      'Posts via Slack\'s 3-step external upload flow (files.getUploadURLExternal → upload → files.completeUploadExternal), which is the only sanctioned path as of 2024+.\n\n' +
      'USE WHEN: the user asks "post this workbook to #channel," "share this with the team in Slack," or any other outbound-file-to-Slack request. The agent has just produced or modified a workbook and wants to deliver it. ' +
      'Free tier — counts against the 10k/mo cap.\n\n' +
      'DO NOT USE WHEN: the file lives in a Slack channel and you want to READ it (that\'s the inbound Manual-Mode-Detector pattern, not this). Or when no Slack bot token is available — the user must have installed a Slack app with files:write scope.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to post.' },
        channel: { type: 'string', description: 'Slack channel ID (C…/G…) the file should land in. Channel names like #general are NOT accepted — resolve to a channel ID first.' },
        slack_token: { type: 'string', description: 'Slack bot token (xoxb-…). Optional when SLACK_BOT_TOKEN env var is set. Passing the token here exposes it in MCP conversation logs — prefer the env var.' },
        message: { type: 'string', description: 'Optional: message to post alongside the file (Slack\'s initial_comment).' },
        filename: { type: 'string', description: 'Optional: filename Slack will display. Defaults to the basename of file_path.' },
      },
      required: ['file_path', 'channel'],
    },
  },

  {
    name: 'xlsx_post_teams',
    description:
      'Upload a local .xlsx file to a Microsoft Teams channel as a file attachment, with an optional accompanying message.\n\n' +
      'Token intake: set TEAMS_GRAPH_TOKEN in the environment (recommended — keeps the token out of conversation logs). Alternatively pass graph_token as a tool argument (legacy; token will appear in MCP history). Uses Microsoft Graph\'s upload-session + chatMessage flow.\n\n' +
      'USE WHEN: the user asks "post this workbook to my Teams channel" or any outbound-file-to-Teams request after producing or modifying a workbook.\n\n' +
      'DO NOT USE WHEN: posting to Slack (use xlsx_post_slack). Or when no Microsoft Graph token is available — the user needs an Entra ID app with Files.ReadWrite.All + ChannelMessage.Send scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to post.' },
        team_id: { type: 'string', description: 'Microsoft Teams team ID (GUID). Find via Graph: GET /me/joinedTeams.' },
        channel_id: { type: 'string', description: 'Microsoft Teams channel ID. Find via Graph: GET /teams/{team-id}/channels.' },
        graph_token: { type: 'string', description: 'Microsoft Graph access token (JWT). Optional when TEAMS_GRAPH_TOKEN env var is set. Passing the token here exposes it in MCP conversation logs — prefer the env var. Must have file-upload + channel-message-send scopes.' },
        message: { type: 'string', description: 'Optional: message to post alongside the file. Plain text; will be HTML-escaped server-side.' },
        filename: { type: 'string', description: 'Optional: filename Teams will display. Defaults to the basename of file_path.' },
      },
      required: ['file_path', 'team_id', 'channel_id'],
    },
  },

  {
    name: 'xlsx_stamp',
    description:
      'Sign a LOCAL .xlsx file with a "workbook integrity verification" stamp — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by these tools, passed these N specific checks, signed at this time, and hasn\'t been tampered with since." Factual claims only (never an opinion-shaped seal of approval). Returns the stamped workbook as base64 in _meta.file_b64; pass out_path to write to disk.\n\n' +
      'The caller supplies the `checks` array (e.g., from a supervisor review): list of named tests, each with passed/failed/skipped status. Verifiers see the individual check results, not a single good/bad opinion.\n\n' +
      'USE WHEN: an agent has just produced or reviewed a workbook and wants to attach provable provenance + check results that travel with the file. Recipients verify via xlsx_verify_stamp.\n\n' +
      'DO NOT USE WHEN: the user just wants to share a file (use xlsx_post_slack / xlsx_post_teams).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to stamp.' },
        checks: {
          type: 'array',
          description: 'Array of named checks, each with passed/failed/skipped status. These are the factual claims the stamp attests to.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable check identifier (e.g., "tieouts_consistent").' },
              name: { type: 'string', description: 'Human-readable check name.' },
              status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
              detail: { type: 'string', description: 'Optional explanation, especially for failed/skipped status.' },
            },
            required: ['id', 'name', 'status'],
          },
        },
        out_path: { type: 'string', description: 'Optional: write the stamped workbook to this absolute path. If omitted, the stamped bytes are returned in _meta.file_b64 only.' },
        exclude_sheets: { type: 'array', items: { type: 'string' }, description: 'Optional: sheet names to exclude from the content hash. Use for scratch tabs that legitimately change without affecting attestation.' },
        supervisor_version: { type: 'string', description: 'Optional: xlsx-supervisor version string to include in the stamp\'s generated_by claim (e.g., "xlsx-supervisor@1.4.0").' },
      },
      required: ['file_path', 'checks'],
    },
  },

  {
    name: 'xlsx_verify_stamp',
    description:
      'verify a workbook\'s embedded integrity-verification stamp. Returns whether the cryptographic signature is valid, whether the workbook bytes match what was signed (recomputed hash vs hash IN the stamp), and the full check-result content of the stamp.\n' +
      'A workbook can fail verification three ways: (1) no stamp present (file was never stamped, or the stamp was stripped); (2) signature_valid=false (someone modified the claims after signing, or signed with a different key); (3) hash_matches=false (someone modified the workbook bytes after signing). Each is a distinct trust signal.\n\n' +
      'USE WHEN: the agent (or a downstream verifier) needs to confirm a workbook hasn\'t been tampered with since it was signed, OR needs to surface the original check results that were attested to. Common scenario: incoming workbook from a counterparty, agent runs verify before trusting any of its values.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to verify.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_receipt',
    description:
      'Attach an AI-generation receipt to a LOCAL .xlsx file — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by THIS agent, at THIS time, against THESE inputs." Returns the receipted workbook as base64 in _meta.file_b64; pass out_path to write to disk.\n\n' +
      'Honesty boundary (load-bearing): the server signs the CALLER-DECLARED `agent.name` — it does NOT verify the caller actually IS that agent. The signature proves "this server signed these strings at this time," not "this came from claude-sonnet-4-6." Caller is responsible for honest declaration. Cryptographic identity binding is v1.1+ scope.\n\n' +
      'USE WHEN: an AI agent generates a workbook and the recipient wants verifiable provenance — "what produced this file, when, against what." Or chaining attestations across a multi-step pipeline.\n\n' +
      'DO NOT USE WHEN: the workbook was human-authored (use xlsx_stamp — Stamp attests to check results, Receipt attests to generation context).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to receipt.' },
        agent_name: {
          type: 'string',
          description: 'Canonical agent name (lowercase + dot/dash/underscore/slash/colon, 1-128 chars). Examples: "claude-sonnet-4-6", "claude-code/0.5.2", "custom:my-agent-v1".',
        },
        agent_display_name: { type: 'string', description: 'Optional: human-readable display name (e.g., "Acme Q4 Forecast Bot").' },
        agent_identity_url: { type: 'string', description: 'Optional: caller-declared identity URL (GitHub repo, registry entry, etc.).' },
        source_file_hashes: {
          type: 'array',
          description: 'Optional: array of {name, sha256} entries describing source files the agent read to produce this workbook.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              sha256: { type: 'string', description: 'Hex SHA-256 (64 lowercase chars).' },
            },
            required: ['name', 'sha256'],
          },
        },
        prompt_hash: { type: 'string', description: 'Optional: hex SHA-256 of the prompt or instruction set that produced the workbook.' },
        mcp_tools_called: { type: 'array', items: { type: 'string' }, description: 'Optional: list of MCP tool names the agent called during generation.' },
        description: { type: 'string', description: 'Optional: short human-readable description of what the workbook is (≤256 chars).' },
        covers_sheets: { type: 'array', items: { type: 'string' }, description: 'Optional: sheets covered by the content hash. Default: all sheets.' },
        out_path: { type: 'string', description: 'Optional: write the receipted workbook to this absolute path. If omitted, the bytes are returned in _meta.file_b64 only.' },
      },
      required: ['file_path', 'agent_name'],
    },
  },

  {
    name: 'xlsx_verify_receipt',
    description:
      'verify a workbook\'s embedded AI-generation receipt. Returns whether the signature is valid, whether the recomputed content hash matches the hash IN the receipt, and the full caller-declared claims (agent identity, generation timestamp, source-file hashes, prompt hash, MCP tools called, description).\n' +
      'A workbook can fail verification three ways: (1) no receipt present (never receipted, or receipt was stripped); (2) signature_valid=false (claims modified after signing); (3) hash_matches=false (workbook bytes modified after receipt was generated). Honesty: a valid receipt proves the SERVER signed the caller-DECLARED agent string — not that the agent IS that.\n\n' +
      'USE WHEN: a workbook arrives claiming AI provenance and the user wants to verify it. Or auditing a corpus of workbooks to find ones with broken receipts (likely-tampered) or no receipts at all.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to verify.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_healer_diagnose',
    description:
      'produce a structured diagnostic report of external references that are broken or at risk in a workbook. Returns five classes of finding: (1) external-workbook references that can\'t resolve, (2) defined-name external refs, (3) Power Query connections with embedded credentials, (4) #REF! propagation maps from upstream breakage, (5) multi-hop chains (workbook → workbook → workbook). Findings carry reference_id keys that downstream cure operations key on.\n\n' +
      'USE WHEN: a workbook shows #REF! errors, an agent moves a file and refs need rewriting, a customer reports "the workbook stopped working after we reorganized SharePoint", or auditing a corpus for hidden external-link breakage before sharing.\n\n' +
      'DO NOT USE WHEN: the user wants the cleaning/normalization surface (use xlsx_data_clean — different concern). Or when there is no .xlsx source path (Healer reads the source bytes, doesn\'t reconstruct from a structured spec).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to diagnose.' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'xlsx_healer_cure',
    description:
      'Apply ONE specific cure operation against a diagnosed workbook. Operations: rename_move (rewrite ref paths), pattern_bulk (regex-style ref rewrites), source_deleted_freeze (replace broken refs with cached values), source_deleted_redirect (point at a replacement file), source_deleted_localize (snapshot external source into a local copy), permission_denied (strip credentials), structure_changed (rewrite formulas for moved cells), format_change (re-link after extension change), make_standalone (fully dereference all externals). Returns cured workbook bytes + receipt.\n\n' +
      'USE WHEN: a diagnostic report (xlsx_healer_diagnose) named a specific operation as the recommended fix; or restoring a workbook whose source moved by a known prefix.\n\n' +
      'DO NOT USE WHEN: the failure mode isn\'t a supported operation (use xlsx_healer_intent for goal-shaped fixes). Or when diagnose hasn\'t been run (cures need diagnose-emitted reference_ids).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to cure.' },
        operation: {
          type: 'string',
          description: 'The cure operation to apply.',
          enum: [
            'rename_move',
            'pattern_bulk',
            'source_deleted_freeze',
            'source_deleted_redirect',
            'source_deleted_localize',
            'permission_denied',
            'structure_changed',
            'format_change',
            'make_standalone',
            'chain_collapse',
            'modernize_to_pq',
          ],
        },
        cure_params: {
          type: 'object',
          description: 'Operation-specific parameters. E.g., rename_move takes {from_prefix, to_prefix}; pattern_bulk takes {pattern, replacement}.',
        },
        mode: {
          type: 'string',
          enum: ['as_copy', 'in_place'],
          description: 'as_copy (default) writes a new file alongside the source; in_place overwrites it.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required as true when mode=in_place. Prevents accidental in-place overwrites; explicit confirmation is the safety gate.',
        },
        out_path: { type: 'string', description: 'Optional: write the cured workbook to this absolute path. Defaults to <name>-healed.xlsx next to the source when mode=as_copy.' },
      },
      required: ['file_path', 'operation'],
    },
  },

  {
    name: 'xlsx_healer_simulate',
    description:
      'simulate recipient-side accessibility of a workbook\'s external references. Given a list of paths the recipient CAN see (`accessible_paths`), returns which references will still resolve at the recipient end and which will break (and why). Read-only; produces no output workbook.\n\n' +
      'USE WHEN: an agent or user wants to know "will this workbook work when I send it to <person>?" before sharing — e.g., before posting to Slack, attaching to email, or sharing a OneDrive link. Or auditing a workbook against a known recipient-accessible-paths inventory.\n\n' +
      'DO NOT USE WHEN: the user wants to FIX the breakage (use xlsx_healer_cure or xlsx_healer_intent). Or when the recipient is the sender themselves (no path discrepancy to simulate).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to simulate.' },
        accessible_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of paths (absolute or URL) the recipient CAN see. Max 1000 entries, each ≤4096 chars. Often a folder tree or a SharePoint root.',
        },
      },
      required: ['file_path', 'accessible_paths'],
    },
  },

  {
    name: 'xlsx_healer_intent',
    description:
      'Goal-driven healing. Caller declares an INTENT (`make-it-work`, `make-standalone`, or `migrate`) instead of a specific cure operation; Healer plans the operation sequence + applies it. make-it-work: minimum surgery to clear errors. make-standalone: fully de-externalize (snapshot every external dep). migrate: rewrite all references against a from/to prefix pair. Returns the planned operations, cured bytes, and an unactionable list.\n\n' +
      'USE WHEN: the user describes the goal in plain English ("just make this work for the recipient" / "send a self-contained version" / "we moved the share root, update the refs"). Or when multiple cure operations need to compose.\n\n' +
      'DO NOT USE WHEN: the user has chosen a specific cure operation (use xlsx_healer_cure directly). Or when no diagnostic has been run on the workbook yet.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file to heal.' },
        intent: {
          type: 'string',
          enum: ['make-it-work', 'make-standalone', 'migrate'],
          description: 'The healing goal. make-it-work: smallest surgery to clear errors. make-standalone: fully dereference all externals. migrate: rewrite against a from/to prefix pair (requires intent_params.from + intent_params.to).',
        },
        intent_params: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source path prefix (required for migrate intent).' },
            to: { type: 'string', description: 'Target path prefix (required for migrate intent).' },
          },
          description: 'Intent-specific parameters. Required keys depend on the intent (migrate needs from + to).',
        },
        mode: {
          type: 'string',
          enum: ['as_copy', 'in_place'],
          description: 'as_copy (default) writes a new file alongside the source; in_place overwrites it.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required as true when mode=in_place. Prevents accidental in-place overwrites; explicit confirmation is the safety gate.',
        },
        out_path: { type: 'string', description: 'Optional: write the cured workbook to this absolute path. Defaults to <name>-healed.xlsx next to the source when mode=as_copy.' },
      },
      required: ['file_path', 'intent'],
    },
  },
  {
    name: 'xlsx_read_handle',
    description:
      'read a workbook that has already been uploaded to the server via the chunked upload flow, by its server-side cache handle, WITHOUT re-transferring the bytes. Returns the same shape as xlsx_read (text / json / markdown) but skips the file_b64 round-trip.\n\n' +
      'USE WHEN: the workbook has already been chunked + finalized into the server-side workbook cache (a `workbook_handle` was returned from the finalize call) and you want to read it again — e.g., a multi-step session where the same large workbook is queried repeatedly. Avoids re-uploading the bytes on every call.\n\n' +
      'DO NOT USE WHEN: you have a local file path and no prior upload (use xlsx_read — it handles the file_b64 transport for you). Handles expire when the cache TTL elapses; the call returns a clear "not found / expired" error in that case.',
    inputSchema: {
      type: 'object',
      properties: {
        workbook_handle: {
          type: 'string',
          description: 'Server-side cache handle returned by the chunked-upload finalize call. 1-128 chars.',
          minLength: 1,
          maxLength: 128,
        },
        sheet: { type: 'string', description: 'Optional: restrict the read to a single sheet by name.' },
        format: {
          type: 'string',
          enum: ['md', 'json'],
          description: 'Output format. Defaults to md.',
        },
      },
      required: ['workbook_handle'],
    },
  },
  {
    name: 'xlsx_session_set_validations',
    description:
      'configure per-session data-validation rules the server will apply to subsequent calls in the same session (e.g., reject rows missing required columns, enforce enum values on a category column, range-bound numeric inputs). Stateful — affects this session only.\n\n' +
      'USE WHEN: the workflow has multiple write/clean steps in sequence and you want consistent server-side validation across them without restating the rules on every call. Or when validating user-supplied data against a known schema you want enforced for the rest of the session.\n\n' +
      'DO NOT USE WHEN: you only have a single call to make (just include the validation logic in that call). Or when you do not have a `session_id` (sessions are returned from the session-create surface; this tool is a no-op without one).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session identifier returned by the session-create surface. 16-128 chars.',
          minLength: 16,
          maxLength: 128,
        },
        validations: {
          type: 'array',
          description: 'List of validation rules to apply. Each rule names a sheet, a cell ref (e.g., "A1:A100"), and a type (whole|decimal|list|date|time|textLength|custom).',
          minItems: 1,
          maxItems: 5000,
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string', description: 'Target sheet name.' },
              ref: { type: 'string', description: 'A1-style cell range the rule applies to.' },
              type: {
                type: 'string',
                description: 'Validation type. Server-side enum: whole, decimal, list, date, time, textLength, custom.',
              },
            },
            required: ['sheet', 'ref', 'type'],
          },
        },
      },
      required: ['session_id', 'validations'],
    },
  },
];

// ---------------------------------------------------------------------------
// File → base64 helper
//
// Security: only spreadsheet extensions are permitted. Any path that resolves
// to a non-allowed extension (or does not exist) is rejected immediately so a
// misbehaving agent cannot exfiltrate arbitrary local files via a tool call.
//
// Stability: a size cap is enforced before the synchronous read so a giant
// workbook can't OOM-kill the MCP server (which would disconnect every tool
// for the user). Override via XFA_MAX_FILE_MB; default is 50 MB.
// ---------------------------------------------------------------------------

const ALLOWED_READ_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv', '.ods', '.fods', '.numbers', '.tsv']);
const DEFAULT_MAX_FILE_MB = 50;

function getMaxFileMB() {
  const raw = process.env.XFA_MAX_FILE_MB;
  if (!raw) return DEFAULT_MAX_FILE_MB;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_MB;
  return parsed;
}

// Expand a leading `~` to the user's home dir so tilde-prefixed paths the
// model passes ("~/Desktop/foo.xlsx") don't dead-end with ENOENT. SPM P1
// 2026-06-06 "secondary" finding — a cheap friction-reducer.
// Only the leading character; we don't try to resolve `~user/foo` patterns.
function expandTilde(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function fileToB64(filePath) {
  const resolved = path.resolve(expandTilde(filePath));

  // Open the file once and operate on the fd from here on. fstatSync and the
  // subsequent read both bind to the inode the fd points at, so even if the
  // path is swapped after the size check the bytes we hash are the bytes we
  // sized — the size-cap TOCTOU is closed.
  // O_NOFOLLOW (where available) refuses symlinks at open time; it's undefined
  // on Windows, where we fall back to 0 (symlink semantics differ there and
  // the spreadsheet-extension allowlist is the load-bearing guard anyway).
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`File not found: ${resolved}`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    if (e && e.code === 'ELOOP') {
      const err = new Error(`Refusing to read symlink: ${resolved}`);
      err.code = 'SYMLINK_REJECTED';
      throw err;
    }
    throw e;
  }

  try {
    const stat = fs.fstatSync(fd);

    if (!stat.isFile()) {
      const err = new Error(`Not a regular file: ${resolved}`);
      err.code = 'NOT_REGULAR_FILE';
      throw err;
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_READ_EXTENSIONS.has(ext)) {
      const err = new Error(
        `Blocked: "${ext}" is not an allowed spreadsheet extension. ` +
        `Allowed: ${[...ALLOWED_READ_EXTENSIONS].join(', ')}`
      );
      err.code = 'DISALLOWED_EXTENSION';
      throw err;
    }

    const maxMB = getMaxFileMB();
    if (stat.size > maxMB * 1024 * 1024) {
      const sizeMB = stat.size / (1024 * 1024);
      const err = new Error(
        `File too large: ${sizeMB.toFixed(1)} MB exceeds the ${maxMB} MB cap. ` +
        `Set XFA_MAX_FILE_MB to a higher value to allow larger workbooks. ` +
        `(The cap protects the MCP server from OOM on synchronous base64 load — ` +
        `a 200 MB workbook would allocate ~267 MB of base64 before any API call.)`
      );
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    // Read exactly stat.size bytes from the fd into a pre-sized buffer. If
    // the file grows between fstat and now, the extra bytes are NOT read —
    // we never allocate more than the validated cap. If the file shrinks
    // (short read), we encode what we got and stop. This closes the
    // grow-after-stat bypass on the size cap.
    const buf = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const chunk = fs.readSync(fd, buf, bytesRead, stat.size - bytesRead, null);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    return buf.subarray(0, bytesRead).toString('base64');
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// File-save helper for tools that return _meta.file_b64
//
// If out_path is provided and _meta.file_b64 is present:  decode + write + append confirmation.
// If out_path is provided but _meta.file_b64 is absent:   append warning (don't claim save).
// If out_path is not provided:                            leave response unchanged.
// ---------------------------------------------------------------------------

// Extensions an MCP tool is allowed to write via out_path. Tighter than the
// READ allowlist (no .ods/.fods/.numbers/.tsv) because the server only ever
// emits XLSX or XLSX-family workbook bytes — accepting unrelated extensions
// would let a malicious / confused agent point out_path at /etc/profile.d/
// or a shell startup script. The .json carve-out is for fixture/audit JSON
// the redact + clean tools sometimes emit alongside the workbook.
const ALLOWED_WRITE_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv', '.json']);

async function applyFileB64(result, outPath) {
  if (!outPath) {
    // No save requested — leave response untouched (b64 stays in _meta for caller)
    return result;
  }

  const absPath = path.resolve(outPath);

  // Containment: require an absolute path + a workbook-family extension.
  // Reject path-traversal patterns and any non-workbook extension at the
  // boundary so a malicious agent can't request a write to a shell-startup
  // location or an arbitrary system file via out_path. Pre-Friday-external
  // CRITICAL per the Tier-1 error-handling audit (2026-06-03).
  const outExt = path.extname(absPath).toLowerCase();
  if (!ALLOWED_WRITE_EXTENSIONS.has(outExt)) {
    if (result.content && result.content[0] && result.content[0].type === 'text') {
      result.content[0].text +=
        `\n\nout_path rejected: extension "${outExt}" is not in the allowed write set ` +
        `(${[...ALLOWED_WRITE_EXTENSIONS].join(', ')}). File was NOT written.`;
    }
    return result;
  }

  if (result._meta && result._meta.file_b64) {
    await fsPromises.writeFile(absPath, Buffer.from(result._meta.file_b64, 'base64'));
    // Append save confirmation to first text content block
    if (result.content && result.content[0] && result.content[0].type === 'text') {
      result.content[0].text += `\n\nFile saved to: ${absPath}`;
    }
  } else {
    // out_path requested but server didn't return file bytes — don't claim save
    if (result.content && result.content[0] && result.content[0].type === 'text') {
      result.content[0].text +=
        '\n\nWarning: out_path was provided but the server did not return file bytes (_meta.file_b64 missing). File was NOT written to disk.';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Boundary error sanitization
//
// The MCP server is a public boundary — anything in err.message that flows
// to the client can end up in the MCP client's conversation log and from
// there into any LLM context window the operator never intended. Map the
// known operational error codes to short, client-safe text; collapse
// everything else to a generic message that names the tool but not the
// internals. Tool name is safe to echo (the caller asked for it); paths,
// upstream server stacks, and third-party response bodies are not.
//
// New codes added here as the client-side error surface grows. Default
// branch is conservative on purpose — better to under-reveal than over-
// reveal at the boundary.
// ---------------------------------------------------------------------------

// Defense in depth on the 4xx inline message. The SPEC's bet is that
// 4xx server messages describe the CALLER'S OWN INPUT (which field,
// what was expected) — but a wrapped 4xx path could still carry
// absolute file paths, emails, JWTs / Bearer tokens, Slack tokens,
// or other PII. Scrub those before surfacing, replace with `<…>`
// placeholders so the caller still sees the SHAPE of the message
// without the sensitive payload.
//
// `<…>` was picked over a more verbose `[redacted-x]` so it's
// visually compact and unambiguously not real input.
const PII_SCRUBBERS = [
  // Bearer / Authorization tokens — match before generic JWT pattern.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, '<bearer>'],
  // JSON Web Tokens. Three dot-separated base64url segments, the first
  // starting with `eyJ` (the canonical JWT header prefix).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>'],
  // Slack bot / user / app tokens.
  [/\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g, '<slack-token>'],
  // Our own API keys.
  [/\bxfa_[a-z]+_[A-Za-z0-9]{16,}\b/g, '<xfa-key>'],
  // Generic 32+ char hex (api keys / hashes).
  [/\b[a-f0-9]{32,}\b/gi, '<hex>'],
  // Emails.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // POSIX absolute paths under /Users, /home, /var, /opt, /tmp, /etc, /private.
  [/\/(?:Users|home|var|opt|tmp|etc|private)\/[^\s'"`)\]]+/g, '<path>'],
  // Windows absolute paths.
  [/[A-Za-z]:\\[^\s'"`)\]]+/g, '<path>'],
];

// Strip the well-known low-signal noise an inline 4xx surface message
// could carry: leading "xlsx-for-ai API error 4xx: " prefix from
// lib/client.js, scrub PII via PII_SCRUBBERS, bound the length so a
// pathological payload can't blow up the conversation log.
const INLINE_4XX_MAX_LEN = 280;
function shapeInline4xxMessage(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/^xlsx-for-ai API error \d+:\s*/i, '').trim();
  for (const [pattern, replacement] of PII_SCRUBBERS) {
    s = s.replace(pattern, replacement);
  }
  if (s.length > INLINE_4XX_MAX_LEN) {
    s = s.slice(0, INLINE_4XX_MAX_LEN - 1) + '…';
  }
  return s;
}

function friendlyErrorMessage(toolName, err) {
  // err may be undefined (defensive) or any thrown value. Extract the
  // fields we care about safely.
  const code = err && err.code;
  const status = err && err.status;
  const payload = err && err.payload;

  // Known client-side / mcp.js error codes — keep their pre-existing
  // short text. Ordered before the 4xx default so the specific message
  // wins.
  switch (code) {
    case 'DISALLOWED_EXTENSION':
      return `${toolName}: file path must point at a workbook (allowed: .xlsx/.xls/.xlsm/.xlsb/.csv/.ods/.fods/.numbers/.tsv).`;
    case 'SYMLINK_REJECTED':
      return `${toolName}: file path resolves through a symlink — provide a direct path.`;
    case 'FILE_TOO_LARGE':
      return `${toolName}: file exceeds the XFA_MAX_FILE_MB cap (default 50 MB).`;
    case 'FILE_NOT_FOUND':
      return `${toolName}: file not found at the supplied path.`;
    case 'NOT_REGULAR_FILE':
      return `${toolName}: file path is not a regular file.`;
    case 'MISSING_TOKEN':
      return `${toolName}: required token env var is not set (see tool docs for which one).`;
    case 'API_UNREACHABLE':
      return `${toolName}: API is unreachable — check network connectivity.`;
    case 'TIER_UPGRADE_REQUIRED':
      return `${toolName}: this capability requires a paid tier.`;
    case 'RATE_LIMITED':
      return `${toolName}: free-tier monthly cap reached — see xlsx-for-ai.dev/pricing.`;
    case 'FALLBACK_ENGINE_MISSING':
      return `${toolName}: local fallback engine not installed (\`npm install @protobi/exceljs\`).`;
    default:
      break;
  }

  // 4xx client-error class: surface the server's validation message
  // inline. SPM 2026-06-06 wild-adoption SPEC. The 4xx surface
  // describes the CALLER'S OWN INPUT shape ("spec.sheets must be an
  // array", "cells[3].address is not a valid Excel address"); the
  // caller needs that message to fix their call. 5xx stays generic
  // (it can carry upstream internals).
  //
  // Known specific HTTP statuses are mapped first so they keep their
  // short curated text:
  if (code === 'API_CLIENT_ERROR') {
    if (status === 429) {
      return `${toolName}: free-tier monthly cap reached — see xlsx-for-ai.dev/pricing.`;
    }
    if (status === 402) {
      return `${toolName}: this capability requires a paid tier.`;
    }
    // Generic 4xx: surface the server message. Prefer the structured
    // shape, fall through to the flat message, fall through to the
    // wrapped err.message (stripped of the "API error 4xx:" prefix).
    let inline = '';
    if (payload && typeof payload === 'object') {
      const structured = payload.error;
      if (structured && typeof structured === 'object' && typeof structured.message === 'string') {
        inline = structured.message;
      } else if (typeof payload.message === 'string') {
        inline = payload.message;
      } else if (typeof payload.error === 'string') {
        inline = payload.error;
      }
    }
    if (!inline && err && typeof err.message === 'string') {
      inline = err.message;
    }
    const shaped = shapeInline4xxMessage(inline);
    if (shaped) {
      return `${toolName}: ${shaped}`;
    }
    // Graceful fallback when no message is available (empty/absent
    // payload, non-string fields): generic with tool name, no
    // `undefined`, no `[object Object]`.
    return `${toolName}: invalid request (no detail provided).`;
  }

  // 5xx and everything else — stay generic. Security boundary preserved.
  if (code === 'API_SERVER_ERROR') {
    return `${toolName}: API returned a server error — retry shortly.`;
  }
  return `${toolName} failed — see server-side logs (request_id in response _meta) for details.`;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(name, args) {
  // xlsx_read: relay to API; fallback to local on unreachable / 5xx
  if (name === 'xlsx_read') {
    const body = {
      file_b64: fileToB64(args.file_path),
      options: { format: args.format, sheet: args.sheet, evaluate: args.evaluate },
    };
    try {
      return await callTool('xlsx_read', body);
    } catch (err) {
      if (err.code === 'API_UNREACHABLE' || err.code === 'API_SERVER_ERROR') {
        return fallbackRead(args.file_path, args);
      }
      throw err;
    }
  }

  // xlsx_diff: two files
  // Server expects file_a_b64 / file_b_b64 (matches xlsx-diff.ts schema).
  if (name === 'xlsx_diff') {
    const body = {
      file_a_b64: fileToB64(args.file_path_a),
      file_b_b64: fileToB64(args.file_path_b),
      options: { sheet: args.sheet },
    };
    return callTool('xlsx_diff', body);
  }

  // xlsx_write: spec or spec_path
  // Server expects { spec, base_file_b64? } — out_path is handled client-side,
  // the server returns the workbook as base64 in _meta.file_b64.
  if (name === 'xlsx_write') {
    let spec = args.spec;
    if (!spec && args.spec_path) {
      // Security: spec_path must exist and must be a .json file.
      const resolvedSpecPath = path.resolve(args.spec_path);
      if (!fs.existsSync(resolvedSpecPath)) {
        const err = new Error(`spec_path not found: ${resolvedSpecPath}`);
        err.code = 'FILE_NOT_FOUND';
        throw err;
      }
      const specExt = path.extname(resolvedSpecPath).toLowerCase();
      if (specExt !== '.json') {
        const err = new Error(
          `spec_path must be a .json file; got "${specExt}". ` +
          'Pass the workbook spec as inline JSON via the "spec" argument instead.'
        );
        err.code = 'DISALLOWED_EXTENSION';
        throw err;
      }
      spec = JSON.parse(fs.readFileSync(resolvedSpecPath, 'utf8'));
    }
    const writeBody = { spec };
    if (args.base_file_b64) writeBody.base_file_b64 = args.base_file_b64;
    const result = await callTool('xlsx_write', writeBody);
    return applyFileB64(result, args.out_path);
  }

  // xlsx_redact: two paths (in + out)
  // out_path is client-side only — strip it before forwarding to the server.
  if (name === 'xlsx_redact') {
    // Forward all server-side options; exclude client-local fields (file_path, out_path).
    const { file_path: _fp, out_path: _op, ...serverOpts } = args;
    const body = {
      file_b64: fileToB64(args.file_path),
      options: serverOpts,
    };
    const result = await callTool('xlsx_redact', body);
    return applyFileB64(result, args.out_path);
  }

  // -------------------------------------------------------------------------
  // Pandas-shaped tools — each builds its own server payload because the
  // server expects different top-level fields per tool (predicates, group_by,
  // by, column, index, etc.).
  // -------------------------------------------------------------------------

  if (name === 'xlsx_describe') {
    return callTool('xlsx_describe', {
      file_b64: fileToB64(args.file_path),
      options: { sheet: args.sheet, header_row: args.header_row, max_rows: args.max_rows },
    });
  }

  if (name === 'xlsx_filter') {
    return callTool('xlsx_filter', {
      file_b64: fileToB64(args.file_path),
      predicates: args.predicates,
      options: { sheet: args.sheet, header_row: args.header_row, limit: args.limit },
    });
  }

  if (name === 'xlsx_aggregate') {
    return callTool('xlsx_aggregate', {
      file_b64: fileToB64(args.file_path),
      group_by: args.group_by,
      aggs: args.aggs,
      options: { sheet: args.sheet, header_row: args.header_row, sort: args.sort, limit: args.limit },
    });
  }

  if (name === 'xlsx_named_ranges') {
    return callTool('xlsx_named_ranges', {
      file_b64: fileToB64(args.file_path),
    });
  }

  if (name === 'xlsx_sort') {
    return callTool('xlsx_sort', {
      file_b64: fileToB64(args.file_path),
      by: args.by,
      options: { sheet: args.sheet, header_row: args.header_row, limit: args.limit },
    });
  }

  if (name === 'xlsx_value_counts') {
    return callTool('xlsx_value_counts', {
      file_b64: fileToB64(args.file_path),
      column: args.column,
      options: {
        sheet: args.sheet,
        header_row: args.header_row,
        top_n: args.top_n,
        include_nulls: args.include_nulls,
      },
    });
  }

  if (name === 'xlsx_formulas') {
    return callTool('xlsx_formulas', {
      file_b64: fileToB64(args.file_path),
      options: { sheet: args.sheet, include_results: args.include_results, limit: args.limit },
    });
  }

  if (name === 'xlsx_tables') {
    return callTool('xlsx_tables', {
      file_b64: fileToB64(args.file_path),
      options: { sheet: args.sheet, include_columns: args.include_columns },
    });
  }

  if (name === 'xlsx_pivot') {
    const body = {
      file_b64: fileToB64(args.file_path),
      index: args.index,
      values: args.values,
      options: { sheet: args.sheet, header_row: args.header_row, fill_value: args.fill_value },
    };
    if (args.columns) body.columns = args.columns;
    if (args.agg) body.agg = args.agg;
    return callTool('xlsx_pivot', body);
  }

  if (name === 'xlsx_eval') {
    const body = {
      file_b64: fileToB64(args.file_path),
      options: { sheet: args.sheet },
    };
    if (args.formulas) body.formulas = args.formulas;
    if (args.cells) body.cells = args.cells;
    return callTool('xlsx_eval', body);
  }

  if (name === 'xlsx_convert') {
    const body = {
      file_b64: fileToB64(args.file_path),
      to: args.to,
      options: { sheet: args.sheet, sheets: args.sheets },
    };
    const result = await callTool('xlsx_convert', body);
    // Binary outputs land bytes in _meta.file_b64 — apply the save helper
    // if the user passed out_path.
    return applyFileB64(result, args.out_path);
  }

  if (name === 'xlsx_validate') {
    return callTool('xlsx_validate', {
      file_b64: fileToB64(args.file_path),
    });
  }

  // xlsx_data_clean: scan + optional execute. Diagnose mode returns
  // findings only (no file_b64 in _meta). Execute mode returns
  // cleaned bytes in _meta.file_b64; applyFileB64 saves to out_path
  // if provided. SPEC fields pass through verbatim — server validates.
  if (name === 'xlsx_data_clean') {
    const body = { file_b64: fileToB64(args.file_path) };
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.detectors !== undefined) body.detectors = args.detectors;
    if (args.sheets !== undefined) body.sheets = args.sheets;
    if (args.options !== undefined) body.options = args.options;
    if (args.overrides !== undefined) body.overrides = args.overrides;
    if (args.accept_findings !== undefined) body.accept_findings = args.accept_findings;
    if (args.reject_findings !== undefined) body.reject_findings = args.reject_findings;
    const result = await callTool('xlsx_data_clean', body);
    return applyFileB64(result, args.out_path);
  }

  // xlsx_post_slack: outbound file-to-Slack. Top-level fields, not the
  // standard {file_b64, options} shape — channel + slack_token + message
  // + filename live alongside file_b64 in the server route's body schema.
  //
  // Token resolution order (H3 fix):
  //   1. SLACK_BOT_TOKEN env var (recommended — never enters conversation logs)
  //   2. slack_token tool arg (legacy; visible in MCP conversation history)
  // Error if neither is present.
  if (name === 'xlsx_post_slack') {
    const slackToken = process.env.SLACK_BOT_TOKEN || args.slack_token;
    if (!slackToken) {
      const err = new Error(
        'Slack token required. Set the SLACK_BOT_TOKEN environment variable ' +
        '(recommended) or pass slack_token as a tool argument.'
      );
      err.code = 'MISSING_TOKEN';
      throw err;
    }
    // fileToB64 enforces existence + extension allowlist (H1 fix) — only
    // spreadsheet extensions (.xlsx, .xlsm, etc.) are permitted here.
    const body = {
      file_b64: fileToB64(args.file_path),
      channel: args.channel,
      slack_token: slackToken,
    };
    if (args.message !== undefined) body.message = args.message;
    body.filename = args.filename || path.basename(args.file_path);
    return callTool('xlsx_post_slack', body);
  }

  // xlsx_post_teams: outbound file-to-Teams. Same shape as Slack but with
  // Microsoft Graph fields (team_id + channel_id + graph_token).
  //
  // Token resolution order (H3 fix):
  //   1. TEAMS_GRAPH_TOKEN env var (recommended — never enters conversation logs)
  //   2. graph_token tool arg (legacy; visible in MCP conversation history)
  // Error if neither is present.
  if (name === 'xlsx_post_teams') {
    const graphToken = process.env.TEAMS_GRAPH_TOKEN || args.graph_token;
    if (!graphToken) {
      const err = new Error(
        'Microsoft Graph token required. Set the TEAMS_GRAPH_TOKEN environment variable ' +
        '(recommended) or pass graph_token as a tool argument.'
      );
      err.code = 'MISSING_TOKEN';
      throw err;
    }
    // fileToB64 enforces existence + extension allowlist (H1 fix) — only
    // spreadsheet extensions (.xlsx, .xlsm, etc.) are permitted here.
    const body = {
      file_b64: fileToB64(args.file_path),
      team_id: args.team_id,
      channel_id: args.channel_id,
      graph_token: graphToken,
    };
    if (args.message !== undefined) body.message = args.message;
    body.filename = args.filename || path.basename(args.file_path);
    return callTool('xlsx_post_teams', body);
  }

  // xlsx_stamp: sign + embed an integrity-verification stamp. Returns the
  // stamped file as base64 in _meta.file_b64; if out_path is provided we
  // also write the bytes to disk (same pattern as xlsx_write / xlsx_redact).
  if (name === 'xlsx_stamp') {
    const body = {
      file_b64: fileToB64(args.file_path),
      checks: args.checks,
    };
    if (args.exclude_sheets !== undefined) body.exclude_sheets = args.exclude_sheets;
    if (args.supervisor_version !== undefined) {
      body.generated_by = { npm: 'xlsx-for-ai@' + require('./package.json').version, supervisor: args.supervisor_version };
    }
    const result = await callTool('xlsx_stamp', body);
    return applyFileB64(result, args.out_path);
  }

  // xlsx_verify_stamp: extract + verify the integrity-verification stamp.
  // Returns structured result in _meta.{valid, signature_valid, hash_matches,
  // claims, workbook_hash_in_stamp, workbook_hash_recomputed, …}.
  if (name === 'xlsx_verify_stamp') {
    const body = { file_b64: fileToB64(args.file_path) };
    return callTool('xlsx_verify_stamp', body);
  }

  // xlsx_receipt: attach an AI-generation receipt. Server signs caller-
  // declared agent + optional inputs (source-file hashes, prompt hash,
  // mcp-tools-called) + optional description; embeds the SignedReceipt in
  // docProps/custom.xml. Honesty: server signs the STRINGS the caller
  // supplied; does NOT verify agent identity.
  if (name === 'xlsx_receipt') {
    const body = {
      file_b64: fileToB64(args.file_path),
      agent: { name: args.agent_name },
    };
    if (args.agent_display_name !== undefined) body.agent.display_name = args.agent_display_name;
    if (args.agent_identity_url !== undefined) body.agent.identity_url = args.agent_identity_url;
    const inputs = {};
    if (args.source_file_hashes !== undefined) inputs.source_file_hashes = args.source_file_hashes;
    if (args.prompt_hash !== undefined) inputs.prompt_hash = args.prompt_hash;
    if (args.mcp_tools_called !== undefined) inputs.mcp_tools_called = args.mcp_tools_called;
    if (Object.keys(inputs).length > 0) body.inputs = inputs;
    if (args.description !== undefined) body.description = args.description;
    if (args.covers_sheets !== undefined) body.covers_sheets = args.covers_sheets;
    const result = await callTool('xlsx_receipt', body);
    return applyFileB64(result, args.out_path);
  }

  // xlsx_verify_receipt: extract + verify the AI-generation receipt.
  // Surfaces caller-declared agent.name as declared; no cryptographic
  // identity binding in v1.
  if (name === 'xlsx_verify_receipt') {
    const body = { file_b64: fileToB64(args.file_path) };
    return callTool('xlsx_verify_receipt', body);
  }

  // xlsx_healer_diagnose: produce structured diagnostic report of broken/
  // at-risk external refs. Read-only; returns the report in the response
  // _meta block. No output file.
  if (name === 'xlsx_healer_diagnose') {
    const body = { file_b64: fileToB64(args.file_path) };
    return callTool('xlsx_healer_diagnose', body);
  }

  // xlsx_healer_cure: apply ONE specific cure operation. Returns the
  // cured bytes in _meta.file_b64 + a per-operation receipt; out_path
  // (or in_place mode) triggers the standard applyFileB64 disk write.
  if (name === 'xlsx_healer_cure') {
    const body = {
      file_b64: fileToB64(args.file_path),
      operation: args.operation,
    };
    if (args.cure_params !== undefined) body.cure_params = args.cure_params;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.confirm !== undefined) body.confirm = args.confirm;
    const result = await callTool('xlsx_healer_cure', body);
    return applyFileB64(result, args.out_path);
  }

  // xlsx_healer_simulate: recipient-side accessibility check. Read-only;
  // returns the simulation report in _meta. No output file.
  if (name === 'xlsx_healer_simulate') {
    const body = {
      file_b64: fileToB64(args.file_path),
      accessible_paths: args.accessible_paths,
    };
    return callTool('xlsx_healer_simulate', body);
  }

  // xlsx_healer_intent: goal-driven healing (plan + apply). Returns the
  // planned operations + cured bytes + unactionable list. Same out_path /
  // in_place semantics as xlsx_healer_cure.
  if (name === 'xlsx_healer_intent') {
    const body = {
      file_b64: fileToB64(args.file_path),
      intent: args.intent,
    };
    if (args.intent_params !== undefined) body.intent_params = args.intent_params;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.confirm !== undefined) body.confirm = args.confirm;
    const result = await callTool('xlsx_healer_intent', body);
    return applyFileB64(result, args.out_path);
  }

  // Handle-based read (no file_b64; the bytes are already in the server
  // cache from a prior chunked-upload finalize). Body mirrors the server
  // schema in routes/xlsx-read-handle.ts.
  if (name === 'xlsx_read_handle') {
    const options = {};
    if (args.sheet !== undefined) options.sheet = args.sheet;
    if (args.format !== undefined) options.format = args.format;
    const body = { workbook_handle: args.workbook_handle };
    if (Object.keys(options).length > 0) body.options = options;
    return callTool('xlsx_read_handle', body);
  }

  // Session-state write — no file bytes, just session_id + validation rules.
  // Body mirrors the server schema in routes/xlsx-session-set-validations.ts.
  if (name === 'xlsx_session_set_validations') {
    return callTool('xlsx_session_set_validations', {
      session_id: args.session_id,
      validations: args.validations,
    });
  }

  // All other tools (list_sheets, schema, hyperlinks, conditional_formats,
  // styles, etc.) — single-file relay. Forward any common option keys the
  // routes accept so we don't silently drop them. New keys added here as
  // tools start accepting them; the server tolerates extras.
  const opts = {};
  if (args.sheet !== undefined) opts.sheet = args.sheet;
  if (args.limit !== undefined) opts.limit = args.limit;
  if (args.detailed !== undefined) opts.detailed = args.detailed;
  const body = {
    file_b64: fileToB64(args.file_path),
    options: opts,
  };
  return callTool(name, body);
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main() {
  // Swallow EPIPE on the transport. When the client disconnects while a
  // background catalog upgrade is still in flight, sendToolListChanged
  // writes to a closed pipe and Node raises EPIPE asynchronously on the
  // Socket — our awaited try/catch around sendToolListChanged never sees
  // it. Without this guard, a client unplug after the upgrade settles
  // crashes the process with an unhandled Socket 'error' event.
  //
  // stdout is the MCP transport: EPIPE there means the client is gone,
  // exit cleanly. stderr is the log sink: an EPIPE on stderr (parent
  // closed its log pipe) is NOT a transport failure and must not take
  // the server down.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      process.exit(0);
    }
    // Anything else on the transport stream is a real failure (e.g.
    // ERR_STREAM_DESTROYED) — rethrow so it surfaces as uncaughtException
    // instead of being silently swallowed.
    throw err;
  });
  process.stderr.on('error', (err) => {
    // Silence EPIPE on stderr; rethrow anything else so we don't hide
    // genuine logging-layer bugs.
    if (!err || err.code !== 'EPIPE') throw err;
  });

  // `initialize` MUST respond from local state — never block on the network.
  // Under Claude Desktop's bundled Node 24.x runtime, the registration POST
  // and the catalog GET can hang indefinitely (Happy-Eyeballs / IPv6 dial
  // edge cases inside Electron), and the client gives up at 60s. The whole
  // MCP attach dies before tools/list is even called.
  //
  // Shape: connect transport FIRST with the bundled TOOLS as the floor.
  // Then background-upgrade registration + catalog with bounded timeouts,
  // and fire notifications/tools/list_changed once the live catalog lands.
  // The bundled set already covers every tool the user reaches in normal
  // flows; the upgrade is additive.
  // sanitizeForMcp guarantees every tool the server emits has a valid
  // inputSchema + description — without it Claude Desktop silently drops
  // tools that lack inputSchema, which is the exact symptom in SPM P0
  // 2026-06-05 (mcp-toolslist-missing-inputschema). For the bundled
  // catalog this is a no-op (every TOOLS entry already has full fields);
  // for the upgraded catalog it's the floor that keeps stub server
  // entries registerable.
  let liveTools = sanitizeForMcp(applyAnnotations(TOOLS));
  process.stderr.write(`xlsx-for-ai-mcp: tool catalog source=bundled count=${liveTools.length}\n`);

  const server = new Server(
    { name: 'xlsx-for-ai', version: require('./package.json').version },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: liveTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Accept any tool the live catalog advertises. dispatchTool has a
    // generic single-file relay path (see end of dispatchTool) that handles
    // any unknown tool name by forwarding {file_b64, options} to the server,
    // so dynamically-discovered tools "just work" as long as their server
    // contract matches that shape.
    const tool = liveTools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await dispatchTool(name, args || {});
      // Pass API response through verbatim (citation footer + _meta preserved)
      return result;
    } catch (err) {
      // Error message sanitization at the MCP boundary. Raw err.message
      // can leak absolute file paths (FILE_NOT_FOUND), upstream server
      // error stacks (any thrown Error inside dispatchTool), and upstream
      // HTTP response bodies (callTool's API_SERVER_ERROR path may carry
      // server internals). Translate the known operational codes into
      // short, client-safe messages; everything else collapses to a
      // generic "tool failed" with the tool name so callers can still
      // route on it without leaking path/server detail. Pre-Friday-
      // external CRITICAL per the Tier-1 audit.
      const safeMessage = friendlyErrorMessage(name, err);
      return {
        content: [{ type: 'text', text: `xlsx-for-ai error: ${safeMessage}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Background-upgrade: registration + dynamic catalog. Bounded so a
  // hung network never wastes resources; failure is non-fatal because
  // the bundled catalog already serves tools/list. Detached on purpose
  // — we do not await this; main() returns and the upgrade lands when
  // it lands.
  upgradeCatalogInBackground(server, (next) => {
    liveTools = next;
  });
}

async function withTimeout(promise, ms, label) {
  // Promise.race with a setTimeout-rejecting promise leaks unhandled
  // rejections in two directions:
  //   (a) Main wins — the timer still fires later and its branch
  //       rejects with nobody awaiting it. clearTimeout in finally
  //       eliminates this.
  //   (b) Timer wins — the original promise can still reject later
  //       (the underlying fetch eventually errors out long after we
  //       gave up). Attaching a no-op catch ensures that late
  //       rejection is consumed instead of crashing the MCP server
  //       minutes after startup.
  // The (b) case is the SPM P0 surface: the bundled-Node-24 dial
  // can stall, time out, and then much later reject with EAI_AGAIN
  // or a TLS error — by then nobody is listening.
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function upgradeCatalogInBackground(server, swap) {
  const REGISTRATION_TIMEOUT_MS = 10_000;
  const CATALOG_TIMEOUT_MS = 8_000;

  try {
    await withTimeout(ensureRegistered(), REGISTRATION_TIMEOUT_MS, 'registration');
  } catch (err) {
    process.stderr.write(`xlsx-for-ai-mcp: registration deferred (${err.message})\n`);
  }

  let catalog;
  try {
    catalog = await withTimeout(resolveCatalog(TOOLS), CATALOG_TIMEOUT_MS, 'catalog fetch');
  } catch (err) {
    process.stderr.write(`xlsx-for-ai-mcp: catalog upgrade skipped (${err.message})\n`);
    return;
  }

  if (!catalog || !Array.isArray(catalog.tools)) {
    return;
  }
  // No upgrade to apply when discover.js fell back to the baked-in set
  // (source=static): the list is identical to what initialize already
  // returned, so a list_changed notification would be wire noise.
  if (catalog.source === 'static') {
    process.stderr.write(`xlsx-for-ai-mcp: catalog upgrade unavailable (source=static) — staying on bundled\n`);
    return;
  }

  const upgraded = sanitizeForMcp(applyAnnotations(catalog.tools));
  swap(upgraded);
  process.stderr.write(`xlsx-for-ai-mcp: tool catalog source=${catalog.source} count=${upgraded.length}\n`);

  try {
    await server.sendToolListChanged();
  } catch (_) {
    // Transport may already be torn down (client disconnected before the
    // upgrade landed). Non-fatal — next attach starts with the bundled
    // catalog and retries the upgrade.
  }
}

// Guard: don't auto-start when required by tests
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`xlsx-for-ai MCP fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// Exports for build-time scripts and tests only. Do NOT import these from
// runtime production code — they're only here to let the manifest-build
// script use TOOLS as the single source of truth for downstream artifacts
// (manifest.json, mcp-tools.json snapshot consumed by the MSFT plugin
// manifest), and to expose helpers under test.
module.exports = { applyFileB64, dispatchTool, TOOLS, friendlyErrorMessage };
