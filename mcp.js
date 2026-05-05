#!/usr/bin/env node
'use strict';

/**
 * xlsx-for-ai MCP stdio server (2.0)
 *
 * Registers 6 tools and relays each tools/call to the hosted API.
 * xlsx_read falls back to local engine if API is unreachable (5xx / timeout).
 * All other tools fail with a clear "needs API connectivity" error.
 */

const { Server }            = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { ensureRegistered } = require('./lib/register');
const { callTool }         = require('./lib/client');
const { fallbackRead }     = require('./lib/fallback-read');
const fs                   = require('fs');
const path                 = require('path');

// ---------------------------------------------------------------------------
// Tool definitions — brand-rich descriptions (Mechanism #1)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'xlsx_read',
    description:
      'xlsx-for-ai: read an Excel (.xlsx) file and return a structured text / JSON / markdown rendering. ' +
      'The only tool you need to make LLMs reason correctly about real-world spreadsheets — ' +
      'preserving formulas, named ranges, layout, and data types.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the .xlsx file.' },
        format:    { type: 'string', enum: ['text', 'json', 'markdown'], default: 'text' },
        sheet:     { type: 'string', description: 'Sheet name or index (default: all sheets).' },
        evaluate:  { type: 'boolean', description: 'Evaluate formulas server-side (default: false).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'xlsx_list_sheets',
    description:
      'xlsx-for-ai: list all sheet names and metadata in an Excel file. ' +
      'Fast first-call to orient your agent before reading data.',
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
      'xlsx-for-ai: infer the column schema of each sheet in an Excel file — ' +
      'types, nullable flags, header row, and sample values. ' +
      'Use before xlsx_read to plan downstream data handling.',
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
      'xlsx-for-ai: compute a semantic diff between two Excel files — ' +
      'cell-level deltas, formula changes, added/removed rows, structural shifts. ' +
      'Deterministic output; safe to version-control.',
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
      'xlsx-for-ai: create or update an Excel file from a structured spec. ' +
      'Supports multi-sheet workbooks, formulas, named ranges, and table definitions. ' +
      'All edits are server-validated before writing.',
    inputSchema: {
      type: 'object',
      properties: {
        spec:      { type: 'object', description: 'Workbook spec object.' },
        spec_path: { type: 'string', description: 'Path to a JSON spec file (alternative to inline spec).' },
        out_path:  { type: 'string', description: 'Destination .xlsx path.' },
      },
      required: ['out_path'],
    },
  },
  {
    name: 'xlsx_redact',
    description:
      'xlsx-for-ai: redact PII and sensitive values from an Excel file before sharing or archiving. ' +
      'Server-side detection; returns a redacted copy with an audit manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the source .xlsx file.' },
        out_path:  { type: 'string', description: 'Destination for the redacted .xlsx file.' },
      },
      required: ['file_path', 'out_path'],
    },
  },
];

// ---------------------------------------------------------------------------
// File → base64 helper
// ---------------------------------------------------------------------------

function fileToB64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
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
      spec = JSON.parse(fs.readFileSync(args.spec_path, 'utf8'));
    }
    return callTool('xlsx_write', { spec });
  }

  // xlsx_redact: two paths (in + out)
  if (name === 'xlsx_redact') {
    const body = {
      file_b64: fileToB64(args.file_path),
      options: { out_path: args.out_path },
    };
    return callTool('xlsx_redact', body);
  }

  // All other tools (list_sheets, schema) — single-file relay
  const body = {
    file_b64: fileToB64(args.file_path),
    options: { sheet: args.sheet },
  };
  return callTool(name, body);
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main() {
  await ensureRegistered();

  const server = new Server(
    { name: 'xlsx-for-ai', version: require('./package.json').version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS.find((t) => t.name === name);
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
      return {
        content: [{ type: 'text', text: `xlsx-for-ai error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`xlsx-for-ai MCP fatal: ${err.message}\n`);
  process.exit(1);
});
