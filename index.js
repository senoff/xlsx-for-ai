#!/usr/bin/env node
'use strict';

/**
 * xlsx-for-ai CLI (2.0) — thin client over the hosted API.
 *
 * Usage:
 *   xlsx-for-ai <file.xlsx> [--json] [--md] [--sheet <name>] [--evaluate]
 *   xlsx-for-ai <file.xlsx> --clean [--execute] [--json] [--sheet <name>] [--detectors <list>]
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
    telemetryStatus: false, enableTelemetry: false, disableTelemetry: false,
    privacyStrict: false, showVersion: false,
    clean: false, execute: false, detectors: null };
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
    else if (a === '--privacy=strict')     opts.privacyStrict = true;
    else if (a === '--version' || a === '-v') opts.showVersion = true;
    else if (a === '--clean')              opts.clean = true;
    else if (a === '--execute')            opts.execute = true;
    else if (a === '--detectors') {
      // Validate the next arg exists + isn't another flag — otherwise
      // `--detectors --json` would silently swallow `--json` as the
      // value. Caught by gpt-5 pre-push panel.
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        process.stderr.write('xlsx-for-ai: --detectors requires a value (comma-separated detector names)\n');
        process.exit(2);
      }
      opts.detectors = next;
    }
    else if (!a.startsWith('--'))          opts.file = a;
    i++;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// --clean flag — data-cleaning pipeline (xlsx_data_clean tool)
// ---------------------------------------------------------------------------

async function runClean(opts, absPath) {
  const fileB64 = fs.readFileSync(absPath).toString('base64');
  const body = { file_b64: fileB64, mode: opts.execute ? 'execute' : 'diagnose' };
  if (opts.sheet) body.sheets = [opts.sheet];
  if (opts.detectors) body.detectors = opts.detectors.split(',').map((s) => s.trim()).filter(Boolean);

  let result;
  try {
    result = await callTool('xlsx_data_clean', body);
  } catch (err) {
    process.stderr.write(`xlsx-for-ai --clean error: ${err.message}\n`);
    process.exit(1);
  }

  const meta = (result && result._meta) || {};
  if (opts.format === 'json') {
    // Strip the cleaned-bytes blob from the JSON payload — it's
    // re-emitted as a saved file below so stdout JSON stays small
    // + human-readable.
    const jsonOut = { ...meta };
    delete jsonOut.file_b64;
    process.stdout.write(JSON.stringify(jsonOut, null, 2) + '\n');
  } else {
    // Default: print the receipt markdown the server already
    // synthesized.
    const text = (result.content || []).map((c) => c.text).join('\n');
    process.stdout.write(text + '\n');
  }

  // Execute mode + applied changes → save cleaned file next to the
  // source. Safe-fallback rule (caught by gpt-5 pre-push panel):
  // the previous regex replace only renamed .xlsx-suffixed files;
  // for non-.xlsx sources (.xlsm, .xlsb, mismatched casing pre-fix)
  // the original path was returned and writeFileSync would overwrite
  // the source. Now: insert "-cleaned" before the last `.` in the
  // path, or append "-cleaned.xlsx" if there's no extension. Output
  // is always distinct from source. Defense-in-depth check refuses
  // to write if the derived path somehow equals the source.
  if (opts.execute && meta.file_b64) {
    let outPath = process.env.XFA_CLEAN_OUT;
    if (!outPath) {
      const lastDot = absPath.lastIndexOf('.');
      if (lastDot > absPath.lastIndexOf('/')) {
        outPath = absPath.slice(0, lastDot) + '-cleaned' + absPath.slice(lastDot);
      } else {
        outPath = absPath + '-cleaned.xlsx';
      }
    }
    if (outPath === absPath) {
      process.stderr.write('xlsx-for-ai --clean: refusing to overwrite source; set XFA_CLEAN_OUT to an explicit output path\n');
      process.exit(1);
    }
    fs.writeFileSync(outPath, Buffer.from(meta.file_b64, 'base64'));
    process.stderr.write(`Cleaned file written to: ${outPath}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.showVersion) { console.log(require('./package.json').version); return; }
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

  // Privacy strict: --privacy=strict flag sets the env var for this process
  // so callTool() (which reads XFA_PRIVACY) adds the header automatically.
  if (opts.privacyStrict) {
    process.env.XFA_PRIVACY = 'strict';
  }

  // --clean diverts to the data-cleaning pipeline before falling
  // through to the default xlsx_read path.
  if (opts.clean) {
    await runClean(opts, absPath);
    return;
  }

  const fileB64 = fs.readFileSync(absPath).toString('base64');
  // Server format enum is 'md' | 'json' | 'sql'. The legacy CLI default 'text'
  // maps to the server's default (md). Don't send 'text' — server rejects it.
  const apiFormat = opts.format === 'text' ? undefined : opts.format;
  const body = {
    file_b64: fileB64,
    options: { format: apiFormat, sheet: opts.sheet, evaluate: opts.evaluate },
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
