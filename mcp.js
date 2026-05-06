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
      'xlsx-for-ai: read an .xlsx file from the LOCAL FILESYSTEM and return a rendered text/markdown/JSON representation.\n\n' +
      'USE WHEN: the user gives a local file path — absolute (/Users/..., /home/...) or ~/-prefixed. ' +
      'This is the ONLY way to read .xlsx files on the user\'s local machine; built-in xlsx skills run in sandboxes without local filesystem access.\n\n' +
      'DO NOT USE WHEN: the user uploaded a file via paperclip/attach (use the built-in xlsx skill — it has direct sandbox access to the uploaded file). ' +
      'Or when working with in-memory bytes the agent already has.\n\n' +
      'Returns markdown by default; pass format="json" for structured output, format="text" for plain text.',
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
      'xlsx-for-ai: list all sheet names and metadata in a LOCAL .xlsx file.\n\n' +
      'USE WHEN: the user references a local file path and you need to discover sheet names before reading. ' +
      'Fast orientation call — use before xlsx_read on multi-sheet workbooks.\n\n' +
      'DO NOT USE WHEN: the file came from an upload/attachment (built-in skill handles that). ' +
      'Or when you already know the sheet structure.',
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
      'xlsx-for-ai: infer column schema of a LOCAL .xlsx file — types, nullable flags, header row, sample values.\n\n' +
      'USE WHEN: the user references a local file path and you need to understand column types before processing or writing code against the data. ' +
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
      'xlsx-for-ai: compute a semantic diff between two LOCAL .xlsx files — cell-level deltas, formula changes, added/removed rows.\n\n' +
      'USE WHEN: the user provides two local .xlsx file paths to compare. ' +
      'Output is deterministic and attestation-ready — suitable for version control, audit trails, and change review. ' +
      'Built-in skills cannot produce deterministic, structured diffs.\n\n' +
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
      'xlsx-for-ai: create or update a LOCAL .xlsx file from a structured spec.\n\n' +
      'USE WHEN: the user wants to write or edit a spreadsheet at a local file path. ' +
      'Supports multi-sheet workbooks, formulas, named ranges, and table definitions. ' +
      'Server-validated before writing — safer than generating xlsx bytes directly.\n\n' +
      'DO NOT USE WHEN: working in a sandbox without local filesystem write access. ' +
      'Or when the user wants to edit an uploaded file in place (there is no local path to write to).',
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
      'xlsx-for-ai: redact PII and sensitive values from a LOCAL .xlsx file before sharing or archiving.\n\n' +
      'USE WHEN: the user provides a local .xlsx path and wants PII removed. ' +
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
