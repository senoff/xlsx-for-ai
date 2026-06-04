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
      // Reject undefined, any `-`-prefixed token, or empty string —
      // `--detectors ""` would otherwise silently disable detection.
      // Caught by gpt-5 pre-push runs 2 + 3.
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        process.stderr.write('xlsx-for-ai: --detectors requires a non-empty value (comma-separated detector names)\n');
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
    process.stderr.write(friendlyCliError('xlsx-for-ai --clean', err) + '\n');
    process.exit(err.code === 'API_UNREACHABLE' || err.code === 'API_SERVER_ERROR' ? 3 : 1);
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
  // source. Cross-platform path derivation via Node's path.parse
  // (caught by gpt-5 pre-push run 2): the earlier lastIndexOf('/')
  // shortcut broke on Windows backslash paths + on directories with
  // dots in the name. path.parse handles both.
  if (opts.execute && meta.file_b64) {
    let outPath = process.env.XFA_CLEAN_OUT;
    if (!outPath) {
      const parsed = path.parse(absPath);
      outPath = path.join(parsed.dir, `${parsed.name}-cleaned${parsed.ext || '.xlsx'}`);
    }
    if (path.resolve(outPath) === path.resolve(absPath)) {
      process.stderr.write('xlsx-for-ai --clean: refusing to overwrite source; set XFA_CLEAN_OUT to an explicit output path\n');
      process.exit(1);
    }
    try {
      fs.writeFileSync(outPath, Buffer.from(meta.file_b64, 'base64'));
      process.stderr.write(`Cleaned file written to: ${outPath}\n`);
    } catch (e) {
      // Caught by gpt-5 pre-push run 2: writeFileSync throws on
      // missing directory / permissions / disk-full. Wrap so the
      // user sees a clear error + exit code, not a stack trace.
      process.stderr.write(`xlsx-for-ai --clean: failed to write ${outPath}: ${e.message}\n`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stamp / Receipt subcommands — thin wrappers around the MCP tool relays.
//
// CLI surface (per ana/specs/stamp.md §4.2 + ana/specs/receipt.md §4.4):
//   xlsx-for-ai stamp <path> --checks <file.json> [--out <path>] [--exclude <s>...] [--supervisor <ver>]
//   xlsx-for-ai verify-stamp <path>
//   xlsx-for-ai receipt <path> --agent <name> [--display-name <s>] [--identity-url <u>]
//       [--source <name>=<sha256>...] [--prompt-hash <sha256>] [--mcp-tool <name>...]
//       [--description <s>] [--cover-sheet <s>...] [--out <path>]
//   xlsx-for-ai verify-receipt <path>
//
// Exit codes (per spec/stamp.md §4.9):
//   0 = success; 1 = verify returned valid=false; 2 = usage error;
//   3 = server-side error; 4 = local file error.
// ---------------------------------------------------------------------------

const STAMP_SUBCOMMANDS = new Set(['stamp', 'verify-stamp', 'receipt', 'verify-receipt']);

// Strip _meta.file_b64 before writing the meta block to stdout. The
// stamped/receipted workbook can be megabytes; dumping it to a terminal
// or CI log clobbers scrollback AND leaks PII-bearing workbook contents
// to whatever consumes stdout. The file is already saved to disk via
// the sidecar / --out path; the b64 in stdout serves no consumer.
// Pre-Friday-external CRITICAL per the Tier-1 audit.
function metaForStdout(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = { ...meta };
  delete out.file_b64;
  return out;
}

// CLI-side error formatter. Same posture as friendlyErrorMessage in
// mcp.js: known operational codes get short, client-safe text; everything
// else collapses to a generic message. err.message can carry absolute
// file paths, upstream stack traces, and third-party HTTP response
// bodies — none of those belong in user-facing CLI stderr or in CI logs.
// Set XFA_DEBUG=1 to see the raw underlying message (for incident triage).
function friendlyCliError(prefix, err) {
  const code = err && err.code;
  const showRaw = process.env.XFA_DEBUG === '1';
  const base = (() => {
    switch (code) {
      case 'API_UNREACHABLE':       return `${prefix}: API is unreachable — check network connectivity.`;
      case 'API_SERVER_ERROR':      return `${prefix}: API returned a server error — retry shortly.`;
      case 'DISALLOWED_EXTENSION':  return `${prefix}: file must be a workbook (allowed: .xlsx/.xls/.xlsm/.xlsb/.csv/.ods/.fods/.numbers/.tsv).`;
      case 'FILE_TOO_LARGE':        return `${prefix}: file exceeds the XFA_MAX_FILE_MB cap (default 50 MB).`;
      case 'FILE_NOT_FOUND':        return `${prefix}: file not found.`;
      case 'MISSING_TOKEN':         return `${prefix}: required token env var is not set.`;
      case 'RATE_LIMITED':          return `${prefix}: free-tier monthly cap reached — see xlsx-for-ai.dev/pricing.`;
      case 'TIER_UPGRADE_REQUIRED': return `${prefix}: this capability requires a paid tier.`;
      case 'FALLBACK_ENGINE_MISSING': return `${prefix}: local fallback engine not installed (\`npm install @protobi/exceljs\`).`;
      default:                      return `${prefix}: request failed${code ? ` (code=${code})` : ''}.`;
    }
  })();
  return showRaw && err && err.message ? `${base}\nRaw: ${err.message}` : base;
}

function nextRequiredArg(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('-')) {
    process.stderr.write(`xlsx-for-ai ${flag} requires a value\n`);
    process.exit(2);
  }
  return v;
}

function loadChecksFile(checksPath) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(checksPath), 'utf8'); }
  catch (e) { process.stderr.write(`Cannot read --checks file: ${e.message}\n`); process.exit(4); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { process.stderr.write(`--checks file is not valid JSON: ${e.message}\n`); process.exit(2); }
  if (!Array.isArray(parsed)) {
    process.stderr.write('--checks file must contain a JSON array of {id, name, status, detail?}\n');
    process.exit(2);
  }
  return parsed;
}

async function runStampSubcommand(subcmd, rest) {
  if (rest.length === 0 || rest[0].startsWith('-')) {
    process.stderr.write(`Usage: xlsx-for-ai ${subcmd} <path> [...]\n`);
    process.exit(2);
  }
  const filePath = path.resolve(rest[0]);
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(4);
  }
  await ensureRegistered();
  const fileB64 = fs.readFileSync(filePath).toString('base64');

  if (subcmd === 'stamp') {
    let checksPath = null, outPath = null, supervisor = null;
    const excludeSheets = [];
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--checks')          checksPath = nextRequiredArg(rest, i++, '--checks');
      else if (a === '--out')        outPath    = nextRequiredArg(rest, i++, '--out');
      else if (a === '--supervisor') supervisor = nextRequiredArg(rest, i++, '--supervisor');
      else if (a === '--exclude')    excludeSheets.push(nextRequiredArg(rest, i++, '--exclude'));
      else { process.stderr.write(`Unknown flag: ${a}\n`); process.exit(2); }
    }
    if (!checksPath) { process.stderr.write('--checks <file.json> is required for stamp\n'); process.exit(2); }
    const body = { file_b64: fileB64, checks: loadChecksFile(checksPath) };
    if (excludeSheets.length) body.exclude_sheets = excludeSheets;
    if (supervisor) body.generated_by = { npm: 'xlsx-for-ai@' + require('./package.json').version, supervisor };
    const result = await callServerForStamp('xlsx_stamp', body, outPath, filePath, '.stamped.xlsx');
    process.stdout.write(JSON.stringify(metaForStdout(result._meta) || {}, null, 2) + '\n');
    return 0;
  }

  if (subcmd === 'verify-stamp') {
    const body = { file_b64: fileB64 };
    const result = await callTool('xlsx_verify_stamp', body);
    const meta = result._meta || {};
    process.stdout.write(JSON.stringify(metaForStdout(meta), null, 2) + '\n');
    return meta.valid === true ? 0 : 1;
  }

  if (subcmd === 'receipt') {
    let agentName = null, displayName = null, identityUrl = null;
    let promptHash = null, description = null, outPath = null;
    const sourceFileHashes = [];
    const mcpToolsCalled = [];
    const coverSheets = [];
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--agent')              agentName     = nextRequiredArg(rest, i++, '--agent');
      else if (a === '--display-name')  displayName   = nextRequiredArg(rest, i++, '--display-name');
      else if (a === '--identity-url')  identityUrl   = nextRequiredArg(rest, i++, '--identity-url');
      else if (a === '--prompt-hash')   promptHash    = nextRequiredArg(rest, i++, '--prompt-hash');
      else if (a === '--description')   description   = nextRequiredArg(rest, i++, '--description');
      else if (a === '--out')           outPath       = nextRequiredArg(rest, i++, '--out');
      else if (a === '--mcp-tool')      mcpToolsCalled.push(nextRequiredArg(rest, i++, '--mcp-tool'));
      else if (a === '--cover-sheet')   coverSheets.push(nextRequiredArg(rest, i++, '--cover-sheet'));
      else if (a === '--source') {
        const pair = nextRequiredArg(rest, i++, '--source');
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) {
          process.stderr.write('--source requires <name>=<sha256> form\n');
          process.exit(2);
        }
        sourceFileHashes.push({ name: pair.slice(0, eqIdx), sha256: pair.slice(eqIdx + 1) });
      }
      else { process.stderr.write(`Unknown flag: ${a}\n`); process.exit(2); }
    }
    if (!agentName) { process.stderr.write('--agent <name> is required for receipt\n'); process.exit(2); }
    const body = { file_b64: fileB64, agent: { name: agentName } };
    if (displayName)  body.agent.display_name  = displayName;
    if (identityUrl)  body.agent.identity_url  = identityUrl;
    const inputs = {};
    if (sourceFileHashes.length) inputs.source_file_hashes = sourceFileHashes;
    if (promptHash)              inputs.prompt_hash         = promptHash;
    if (mcpToolsCalled.length)   inputs.mcp_tools_called    = mcpToolsCalled;
    if (Object.keys(inputs).length) body.inputs = inputs;
    if (description) body.description = description;
    if (coverSheets.length) body.covers_sheets = coverSheets;
    const result = await callServerForStamp('xlsx_receipt', body, outPath, filePath, '.receipted.xlsx');
    process.stdout.write(JSON.stringify(metaForStdout(result._meta) || {}, null, 2) + '\n');
    return 0;
  }

  if (subcmd === 'verify-receipt') {
    const body = { file_b64: fileB64 };
    const result = await callTool('xlsx_verify_receipt', body);
    const meta = result._meta || {};
    process.stdout.write(JSON.stringify(metaForStdout(meta), null, 2) + '\n');
    return meta.valid === true ? 0 : 1;
  }
  return 2;
}

async function callServerForStamp(tool, body, explicitOutPath, sourcePath, sidecarSuffix) {
  let result;
  try {
    result = await callTool(tool, body);
  } catch (err) {
    process.stderr.write(friendlyCliError(`xlsx-for-ai ${tool}`, err) + '\n');
    process.exit(err.code === 'API_UNREACHABLE' || err.code === 'API_SERVER_ERROR' ? 3 : 1);
  }
  const meta = result._meta || {};
  if (!meta.file_b64) return result;
  let outPath = explicitOutPath;
  if (!outPath) {
    const parsed = path.parse(sourcePath);
    outPath = path.join(parsed.dir, `${parsed.name}${sidecarSuffix}`);
  }
  if (path.resolve(outPath) === path.resolve(sourcePath)) {
    process.stderr.write(`xlsx-for-ai ${tool}: refusing to overwrite source — pass --out <other-path>\n`);
    process.exit(2);
  }
  try { fs.writeFileSync(outPath, Buffer.from(meta.file_b64, 'base64')); }
  catch (e) { process.stderr.write(`xlsx-for-ai ${tool}: failed to write ${outPath}: ${e.message}\n`); process.exit(4); }
  process.stderr.write(`Wrote ${outPath}\n`);
  return result;
}

async function main() {
  // Subcommand dispatch — stamp/verify-stamp/receipt/verify-receipt
  // route through dedicated handlers; everything else uses the legacy
  // flag-only CLI (xlsx-for-ai <file> [--json|--md|--clean|...]).
  const argv = process.argv.slice(2);
  if (argv.length > 0 && STAMP_SUBCOMMANDS.has(argv[0])) {
    const code = await runStampSubcommand(argv[0], argv.slice(1));
    process.exit(code);
  }

  const opts = parseArgs(argv);

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
      process.stderr.write(friendlyCliError('xlsx-for-ai', err) + '\n');
      process.exit(1);
    }
  }

  const text = (result.content || []).map((c) => c.text).join('\n');
  process.stdout.write(text + '\n');
}

main().catch((err) => {
  process.stderr.write(friendlyCliError('xlsx-for-ai', err) + '\n');
  process.exit(1);
});
