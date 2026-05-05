#!/usr/bin/env node
'use strict';

/**
 * xlsx-for-ai CLI (2.0) — thin client over the hosted API.
 *
 * Usage:
 *   xlsx-for-ai <file.xlsx> [--json] [--md] [--sheet <name>] [--evaluate]
 *   xlsx-for-ai --telemetry-status
 *   xlsx-for-ai --enable-telemetry
 *   xlsx-for-ai --disable-telemetry
 *
 * cursor-reads-xlsx is a back-compat alias for xlsx-for-ai.
 */

const fs   = require('fs');
const path = require('path');

const { ensureRegistered } = require('./lib/register');
const { callTool }         = require('./lib/client');
const { fallbackRead }     = require('./lib/fallback-read');
const {
  telemetryStatus,
  enableTelemetry,
  disableTelemetry,
} = require('./lib/config');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { file: null, format: 'text', sheet: null, evaluate: false,
    telemetryStatus: false, enableTelemetry: false, disableTelemetry: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if      (a === '--json')               opts.format = 'json';
    else if (a === '--md')                 opts.format = 'markdown';
    else if (a === '--evaluate')           opts.evaluate = true;
    else if (a === '--sheet')              { opts.sheet = argv[++i]; }
    else if (a === '--telemetry-status')   opts.telemetryStatus = true;
    else if (a === '--enable-telemetry')   opts.enableTelemetry = true;
    else if (a === '--disable-telemetry')  opts.disableTelemetry = true;
    else if (!a.startsWith('--'))          opts.file = a;
    i++;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.telemetryStatus) { console.log(telemetryStatus()); return; }
  if (opts.enableTelemetry)  { enableTelemetry();  console.log('Telemetry enabled.'); return; }
  if (opts.disableTelemetry) { disableTelemetry(); console.log('Telemetry disabled.'); return; }

  if (!opts.file) {
    process.stderr.write('Usage: xlsx-for-ai <file.xlsx> [--json] [--md] [--sheet <name>] [--evaluate]\n');
    process.exit(1);
  }

  const absPath = path.resolve(opts.file);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`File not found: ${absPath}\n`);
    process.exit(1);
  }

  await ensureRegistered();

  const fileB64 = fs.readFileSync(absPath).toString('base64');
  const body = {
    file_b64: fileB64,
    options: { format: opts.format, sheet: opts.sheet, evaluate: opts.evaluate },
  };

  let result;
  try {
    result = await callTool('xlsx_read', body);
  } catch (err) {
    if (err.code === 'API_UNREACHABLE' || err.code === 'API_SERVER_ERROR') {
      result = await fallbackRead(absPath, opts);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }

  const text = (result.content || []).map((c) => c.text).join('\n');
  process.stdout.write(text + '\n');
}

main().catch((err) => {
  process.stderr.write(`xlsx-for-ai: ${err.message}\n`);
  process.exit(1);
});
