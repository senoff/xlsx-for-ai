#!/usr/bin/env node

// Self-respawn with a larger V8 heap before loading anything else.
// Some real-world .xlsx files (sub-1MB on disk but with huge calc chains or
// shared-string tables) blow Node's default ~4GB heap during parse. Re-execing
// with --max-old-space-size=8192 fixes this transparently. The sentinel env
// var prevents an infinite respawn loop.
if (!process.env.XLSX_FOR_AI_RESPAWNED) {
  const v8 = require('v8');
  const heapLimitMB = v8.getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (heapLimitMB < 8000) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      process.execPath,
      ['--max-old-space-size=8192', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, XLSX_FOR_AI_RESPAWNED: '1' } }
    );
    process.exit(r.status ?? 1);
  }
}

const path = require('path');
const fs   = require('fs');
// All xlsx-engine access goes through the engine abstraction in lib/engine.js
// — lib/engine.js is the ONLY place in lib/ that requires @protobi/exceljs.
// To swap engines (fork, different library, server-side service), replace
// lib/engine.js; nothing else changes. Current engine: @protobi/exceljs
// (drop-in fork of exceljs with active maintenance + preservation patches;
// see ROADMAP for rationale).
const engine = require('./lib/engine');

// Lazy-load heavy deps only when their feature is used (keeps cold start fast
// for the common --stdout / --json / --md path that needs none of them).
let _papaLib, _formulaJsLib, _tokenizerLib;
const lazyPapa       = () => (_papaLib       ??= require('papaparse'));
const lazyFormulaJs  = () => (_formulaJsLib  ??= require('@formulajs/formulajs'));
const lazyTokenizer  = () => (_tokenizerLib  ??= require('gpt-tokenizer'));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    positional: [],
    listSheets: false,
    stdout: false,
    json: false,
    md: false,
    sql: false,
    schema: false,
    compact: false,
    evaluate: false,
    stream: false,
    diff: null,
    range: null,
    namedRange: null,
    region: false,
    maxRows: null,
    maxCols: null,
    maxTokens: null,
    reportBug: null,
    exportRedactedWorkbook: null,
    help: false,
    enableTelemetry: false,
    disableTelemetry: false,
    telemetryStatus: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if      (arg === '--list-sheets')   opts.listSheets = true;
    else if (arg === '--stdout')        opts.stdout = true;
    else if (arg === '--json')          opts.json = true;
    else if (arg === '--md')            opts.md = true;
    else if (arg === '--sql')           opts.sql = true;
    else if (arg === '--schema')        opts.schema = true;
    else if (arg === '--compact')       opts.compact = true;
    else if (arg === '--evaluate')      opts.evaluate = true;
    else if (arg === '--stream')        opts.stream = true;
    else if (arg === '--diff')        { opts.diff = argv[++i]; }
    else if (arg === '--range')       { opts.range = argv[++i]; }
    else if (arg === '--named-range') { opts.namedRange = argv[++i]; }
    else if (arg === '--region')       opts.region = true;
    else if (arg === '--max-rows')    { opts.maxRows = parseInt(argv[++i], 10); }
    else if (arg === '--max-cols')    { opts.maxCols = parseInt(argv[++i], 10); }
    else if (arg === '--max-tokens')  { opts.maxTokens = parseInt(argv[++i], 10); }
    else if (arg === '--report-bug')              { opts.reportBug = argv[++i]; }
    else if (arg === '--export-redacted-workbook'){ opts.exportRedactedWorkbook = argv[++i]; }
    else if (arg === '--enable-telemetry')        opts.enableTelemetry = true;
    else if (arg === '--disable-telemetry')       opts.disableTelemetry = true;
    else if (arg === '--telemetry-status')        opts.telemetryStatus = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else                                opts.positional.push(arg);
    i++;
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: npx xlsx-for-ai <file> [sheetName] [options]
       npx xlsx-for-ai write <spec> [-o output.xlsx]   (build .xlsx from a spec)

Converts spreadsheets to text, markdown, JSON, SQL, or schema dumps that AI
coding agents can read. Preserves values, formulas, formatting, layout.

The 'write' sub-command does the reverse: takes a JSON or markdown spec and
produces an .xlsx file. Run 'xlsx-for-ai write --help' for details.

Input formats: .xlsx .csv .tsv

Output modes (mutually exclusive; default = text):
  --md              Markdown tables — best LLM comprehension per token
  --json            Structured JSON, one object per cell
  --sql             SQL CREATE TABLE + INSERT statements (uses --schema)
  --schema          Inferred per-column schema (name, type, sample) as JSON

Selection:
  [sheetName]       Positional second arg, dump only this sheet
  --range A1:D50    Dump only this rectangular range
  --named-range NM  Dump only the cells covered by this defined name
  --region          Auto-detect the dominant contiguous data block (Excel
                    "current region" semantics); picks the largest region
                    by populated-cell count when multiple disjoint blocks
                    exist. Compatible with --max-rows / --max-cols.
  --max-rows N      Limit to first N rows per sheet
  --max-cols N      Limit to first N columns per sheet

Output control:
  --stdout          Print to stdout instead of writing files in .xlsx-read/
  --list-sheets     Print sheet names + dimensions and exit
  --compact         Suppress noisy default tags (default colors, General fmt)
  --max-tokens N    Truncate output to ~N tokens (cl100k_base proxy);
                    appends a tail summary noting what was dropped
  --evaluate        Promote cached formula results to primary value;
                    re-evaluate simple formulas via formulajs

Other modes:
  --diff OTHER      Diff this workbook vs OTHER, emit changed cells/sheets
  --stream          Streaming reader for huge .xlsx files (>100MB);
                    emits row-by-row, drops some sheet metadata

Bug reporting (privacy-by-design — no data leaves your machine):
  --report-bug <input.xlsx>
                    Generate xlsx-for-ai-bugreport-<ISO>.json describing
                    the workbook's structure (sheet count/shape, feature
                    inventory, env). Contains zero cell values, formulas,
                    or named-range targets. Attach to a GitHub issue.
  --export-redacted-workbook <input.xlsx>
                    Produce <input>-redacted.xlsx with every cell value
                    replaced by a typed placeholder (numbers→0,
                    strings→"x", bools→false, dates→1900-01-01). Formulas,
                    structure, styles, named ranges preserved. Optional
                    attachment for hard-to-repro bugs.

Crash telemetry (opt-in only):
  --enable-telemetry
                    Opt in to anonymous crash telemetry. Only error type,
                    sanitized error message (paths scrubbed, ≤200 chars),
                    tool version, Node version, and OS/arch are sent.
                    No paths, no cell values, no identifiers.
                    Payload: { v, ts, error_type, error_message, command,
                               xlsx_for_ai_version, node_version, os_arch }
                    Consent persists at ~/.xlsx-for-ai/config.json across
                    upgrades.
  --disable-telemetry
                    Opt out. Config file is kept (explicit "no" is recorded).
  --telemetry-status
                    Show current state and config path.

Misc:
  -h, --help        Show this help

Examples:
  npx xlsx-for-ai data.xlsx
  npx xlsx-for-ai data.xlsx --md --stdout
  npx xlsx-for-ai data.xlsx --json --max-tokens 8000 --stdout
  npx xlsx-for-ai data.csv --md --stdout
  npx xlsx-for-ai data.xlsx --range B2:F100 --stdout
  npx xlsx-for-ai data.xlsx --region --stdout
  npx xlsx-for-ai data.xlsx --region --max-rows 50 --stdout
  npx xlsx-for-ai data.xlsx --named-range MyTotals --stdout
  npx xlsx-for-ai data.xlsx --sql --stdout > schema.sql
  npx xlsx-for-ai old.xlsx --diff new.xlsx --stdout
  npx xlsx-for-ai huge.xlsx --stream --stdout

Note: this package was previously published as 'cursor-reads-xlsx';
that command name still works as an alias.`);
}

// ---------------------------------------------------------------------------
// Helpers (ref math, formatting)
// ---------------------------------------------------------------------------

function colLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function colNum(letters) {
  let n = 0;
  const u = letters.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    n = n * 26 + (u.charCodeAt(i) - 64);
  }
  return n;
}

// Parse "A1:D50" or "B2" into {startCol, startRow, endCol, endRow} (1-indexed).
function parseRange(s) {
  if (!s) return null;
  const parts = s.split(':');
  const m1 = /^([A-Z]+)(\d+)$/i.exec(parts[0]);
  if (!m1) throw new Error(`Invalid range: ${s}`);
  const startCol = colNum(m1[1]);
  const startRow = parseInt(m1[2], 10);
  if (parts.length === 1) {
    return { startCol, startRow, endCol: startCol, endRow: startRow };
  }
  const m2 = /^([A-Z]+)(\d+)$/i.exec(parts[1]);
  if (!m2) throw new Error(`Invalid range: ${s}`);
  return {
    startCol,
    startRow,
    endCol: colNum(m2[1]),
    endRow: parseInt(m2[2], 10),
  };
}

const DEFAULT_TEXT_COLORS = new Set([
  'FF000000', 'FF1F1F1F', 'FF222120', 'FF333333',
]);
function isDefaultTextColor(argb) {
  return argb && DEFAULT_TEXT_COLORS.has(argb.toUpperCase());
}

function describeFill(fill, compact) {
  if (!fill || (fill.type === 'pattern' && fill.pattern === 'none')) return null;
  if (fill.type === 'pattern' && fill.fgColor?.argb) {
    if (compact && /^FF?FFFFFF$/i.test(fill.fgColor.argb)) return null;
    return `fill:${fill.fgColor.argb}`;
  }
  return null;
}

function describeFont(font, compact) {
  const parts = [];
  if (font?.bold)   parts.push('bold');
  if (font?.italic) parts.push('italic');
  if (font?.color?.argb && !(compact && isDefaultTextColor(font.color.argb))) {
    parts.push(`color:${font.color.argb}`);
  }
  return parts;
}

function formatValue(v) {
  if (v == null) return '""';
  if (v instanceof Date) return `"${v.toISOString().slice(0, 10)}"`;
  if (typeof v === 'object' && v.richText) {
    return `"${v.richText.map(r => r.text).join('')}"`;
  }
  if (typeof v === 'object' && v.hyperlink) {
    return `"${v.text || v.hyperlink}"`;
  }
  if (typeof v === 'object' && (v.formula || v.sharedFormula)) {
    const result = v.result;
    if (result == null) return '""';
    if (typeof result === 'object') {
      if (result.error)    return `"#${result.error}"`;
      if (result.richText) return `"${result.richText.map(r => r.text).join('')}"`;
      return JSON.stringify(result);
    }
    if (typeof result === 'string') return `"${result}"`;
    return String(result);
  }
  if (typeof v === 'object' && v.error) return `"#${v.error}"`;
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

// Plain (unquoted) value extraction — for markdown/SQL/schema where we don't
// want JSON quoting. Returns string or null for empty cells.
function plainValue(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.hyperlink) return v.text || v.hyperlink;
    // Recognize all four shapes formulas can take in our pipeline:
    // ExcelJS read: {formula, result} or {sharedFormula, result}
    // --json output: {formula, result} or {sharedFormulaRef, result}
    if (v.formula || v.sharedFormula || v.sharedFormulaRef) {
      const r = v.result;
      if (r == null) return null;
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      if (typeof r === 'object') {
        if (r.error) return `#${r.error}`;
        if (r.richText) return r.richText.map(x => x.text).join('');
        return String(r);
      }
      return String(r);
    }
    if (v.error) return `#${v.error}`;
    return JSON.stringify(v);
  }
  return String(v);
}

function describeNote(note) {
  if (!note) return null;
  if (typeof note === 'string') return note;
  if (note.texts) {
    return note.texts.map(t => (typeof t === 'string' ? t : t.text || '')).join('');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Named ranges
// ---------------------------------------------------------------------------

function getNamedRanges(wb, sheetName) {
  const results = [];
  try {
    const model = wb.definedNames?.model;
    if (!Array.isArray(model)) return results;
    for (const def of model) {
      if (!def.ranges?.length) continue;
      if (sheetName) {
        const relevant = def.ranges.filter(r => r.includes(sheetName + '!'));
        if (relevant.length) results.push({ name: def.name, ranges: relevant });
      } else {
        results.push({ name: def.name, ranges: def.ranges });
      }
    }
  } catch (_) {}
  return results;
}

// Resolve a named range to {sheet, range} pieces. Excel names look like
// 'Sheet1!$A$1:$D$10' (absolute) or 'Sheet1!A1:D10'.
function resolveNamedRange(wb, name) {
  const model = wb.definedNames?.model;
  if (!Array.isArray(model)) return null;
  const def = model.find(d => d.name === name);
  if (!def || !def.ranges?.length) return null;
  const ref = def.ranges[0];
  const m = /^(?:'([^']+)'|([^!]+))!(.+)$/.exec(ref);
  if (!m) return null;
  const sheetName = (m[1] || m[2]).trim();
  const rangeStr = m[3].replace(/\$/g, '');
  return { sheet: sheetName, range: parseRange(rangeStr) };
}

// ---------------------------------------------------------------------------
// Region detection — "current region" semantics (Excel Ctrl+Shift+*)
//
// Finds the dominant contiguous data block on a worksheet. Algorithm:
//   1. Scan the sheet to collect all populated cells.
//   2. Build connected components using 8-neighbor flood fill (cells that
//      share a corner or edge are in the same region).
//   3. For each component, compute the bounding rectangle and the count of
//      populated cells inside it.
//   4. Return the bounding box of the component with the most populated cells
//      (tie-break: largest populated count; if still tied, the first found).
//
// Returns {startRow, startCol, endRow, endCol} (1-indexed), or null if the
// sheet has no populated cells.
// ---------------------------------------------------------------------------

function detectRegion(ws) {
  // Step 1: collect all populated cells into a Set for O(1) lookup.
  // We store them as "row,col" strings and also keep a list for iteration.
  const populated = new Set();
  const cells = [];

  const rowCount = ws.rowCount;
  const colCount = ws.columnCount;
  if (rowCount === 0 || colCount === 0) return null;

  // ExcelJS reports rowCount/columnCount as the highest USED row/column,
  // not actual storage. A workbook with one cell at XFD1048576 reports
  // 1048576 × 16384 = ~17B coordinates. Refuse the scan past 5M cells —
  // pathological/malicious inputs would otherwise hang the CLI.
  if (rowCount * colCount > 5_000_000) {
    console.warn(
      `detectRegion: workbook reports ${rowCount}×${colCount} cell dimensions, ` +
      `exceeds 5M-cell scan cap; skipping region detection`
    );
    return null;
  }

  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= colCount; c++) {
      const v = row.getCell(c).value;
      if (v != null && v !== '') {
        const key = `${r},${c}`;
        populated.add(key);
        cells.push([r, c]);
      }
    }
  }

  if (cells.length === 0) return null;

  // Step 2: flood-fill connected components (8-neighbor).
  const visited = new Set();
  const components = [];

  for (const [startR, startC] of cells) {
    const key = `${startR},${startC}`;
    if (visited.has(key)) continue;

    // BFS from this seed cell.
    const component = [];
    const queue = [[startR, startC]];
    visited.add(key);

    while (queue.length > 0) {
      const [r, c] = queue.shift();
      component.push([r, c]);
      // 8 neighbors
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 1 || nc < 1) continue;
          const nk = `${nr},${nc}`;
          if (!visited.has(nk) && populated.has(nk)) {
            visited.add(nk);
            queue.push([nr, nc]);
          }
        }
      }
    }
    components.push(component);
  }

  // Step 3: pick the component with the most populated cells.
  let best = null;
  let bestCount = -1;
  for (const comp of components) {
    if (comp.length > bestCount) {
      bestCount = comp.length;
      best = comp;
    }
  }

  // Step 4: compute bounding rectangle of the winning component.
  let minR = Infinity, maxR = -Infinity;
  let minC = Infinity, maxC = -Infinity;
  for (const [r, c] of best) {
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }

  return { startRow: minR, endRow: maxR, startCol: minC, endCol: maxC };
}

// ---------------------------------------------------------------------------
// Selection bounds — combines --range, --named-range, --max-rows/cols, sheet
// dimensions into a single {startRow, startCol, endRow, endCol}.
// ---------------------------------------------------------------------------

function selectionBounds(ws, opts) {
  let bounds = null;
  if (opts.range) {
    bounds = parseRange(opts.range);
  } else if (opts.namedRangeBounds) {
    bounds = opts.namedRangeBounds;
  } else if (opts.region) {
    bounds = detectRegion(ws);
    // bounds may be null (empty sheet); handled below by falling back to sheet dimensions.
  }
  const startRow = bounds ? bounds.startRow : 1;
  const startCol = bounds ? bounds.startCol : 1;
  let endRow = bounds ? bounds.endRow : ws.rowCount;
  let endCol = bounds ? bounds.endCol : ws.columnCount;
  if (opts.maxRows) endRow = Math.min(endRow, startRow + opts.maxRows - 1);
  if (opts.maxCols) endCol = Math.min(endCol, startCol + opts.maxCols - 1);
  return { startRow, startCol, endRow, endCol };
}

// ---------------------------------------------------------------------------
// Sheet dump (text)
// ---------------------------------------------------------------------------

function dumpSheet(ws, wb, opts = {}) {
  const { compact = false } = opts;
  const { startRow, startCol, endRow, endCol } = selectionBounds(ws, opts);
  const lines = [];

  lines.push(`=== Sheet: ${ws.name} ===`);

  const frozen = (ws.views || []).find(v => v.state === 'frozen');
  if (frozen) lines.push(`Frozen: row ${frozen.ySplit ?? 0}, col ${frozen.xSplit ?? 0}`);

  // Columns
  const colWidths = [];
  const hiddenCols = [];
  for (let c = startCol; c <= endCol; c++) {
    const col = ws.getColumn(c);
    const letter = colLetter(c);
    if (col.hidden) hiddenCols.push(letter);
    if (col.width) colWidths.push(`${letter}(${Math.round(col.width)})`);
  }
  if (colWidths.length) lines.push(`Columns: ${colWidths.join(' ')}`);
  if (hiddenCols.length) lines.push(`Hidden columns: ${hiddenCols.join(', ')}`);
  if (opts.maxCols && ws.columnCount > endCol) {
    lines.push(`(${ws.columnCount - endCol} more columns truncated)`);
  }

  const merges = (ws.model && Array.isArray(ws.model.merges)) ? ws.model.merges : [];
  if (merges.length) lines.push(`Merged: ${merges.join(', ')}`);

  if (ws.autoFilter) {
    const af = typeof ws.autoFilter === 'string'
      ? ws.autoFilter
      : (ws.autoFilter.ref || JSON.stringify(ws.autoFilter));
    lines.push(`Auto-filter: ${af}`);
  }

  try { if (ws.pageSetup?.printArea) lines.push(`Print area: ${ws.pageSetup.printArea}`); } catch (_) {}

  const namedRanges = getNamedRanges(wb, ws.name);
  if (namedRanges.length) {
    lines.push(`Named ranges:`);
    for (const nr of namedRanges) lines.push(`  ${nr.name}: ${nr.ranges.join(', ')}`);
  }

  // Tables
  try {
    const tableMap = ws.tables;
    if (tableMap && typeof tableMap === 'object') {
      const tables = typeof tableMap.forEach === 'function'
        ? (() => { const a = []; tableMap.forEach(t => a.push(t)); return a; })()
        : Object.values(tableMap);
      for (const t of tables) {
        const model = t.table || t.model || t;
        const name = model.name || model.displayName || '(unnamed)';
        const ref = model.ref || model.tableRef || '';
        const cols = (model.columns || []).map(c => c.name).filter(Boolean);
        let desc = `Table: "${name}" ${ref}`;
        if (cols.length) desc += ` — columns: ${cols.join(', ')}`;
        lines.push(desc);
      }
    }
  } catch (_) {}

  try {
    const images = typeof ws.getImages === 'function' ? ws.getImages() : [];
    for (const img of images) {
      if (img.range?.tl) {
        const tl = img.range.tl, br = img.range.br;
        if (br) lines.push(`Image: ${colLetter(Math.floor(tl.col)+1)}${Math.floor(tl.row)+1} to ${colLetter(Math.floor(br.col)+1)}${Math.floor(br.row)+1}`);
        else    lines.push(`Image at: ${colLetter(Math.floor(tl.col)+1)}${Math.floor(tl.row)+1}`);
      }
    }
  } catch (_) {}

  lines.push('');

  for (let r = startRow; r <= endRow; r++) {
    const row = ws.getRow(r);
    const cells = [];
    const isHidden = row.hidden;
    for (let c = startCol; c <= endCol; c++) {
      const cell = row.getCell(c);
      const raw = cell.value;
      if (raw == null || raw === '') continue;
      const ref = `${colLetter(c)}${r}`;
      const tags = [];
      if (cell.type === engine.ValueType.Formula && typeof raw === 'object') {
        if (raw.formula) tags.push(`formula: =${raw.formula}`);
        else if (raw.sharedFormula) tags.push(`shared formula ref: ${raw.sharedFormula}`);
      }
      if (cell.numFmt && cell.numFmt !== 'General') tags.push(`numFmt: ${cell.numFmt}`);
      const fontTags = describeFont(cell.font, compact);
      if (fontTags.length) tags.push(...fontTags);
      const fillDesc = describeFill(cell.fill, compact);
      if (fillDesc) tags.push(fillDesc);
      if (cell.alignment?.horizontal && cell.alignment.horizontal !== 'general') tags.push(`align:${cell.alignment.horizontal}`);
      if (cell.hyperlink) tags.push(`link: ${cell.hyperlink}`);
      else if (typeof raw === 'object' && raw.hyperlink) tags.push(`link: ${raw.hyperlink}`);
      const noteText = describeNote(cell.note);
      if (noteText) tags.push(`note: ${noteText.replace(/\n/g, ' ').trim()}`);
      if (cell.dataValidation) {
        const dv = cell.dataValidation;
        if (dv.type === 'list' && dv.formulae?.length) tags.push(`validation: list [${dv.formulae[0]}]`);
        else if (dv.type) {
          const parts = [dv.type];
          if (dv.operator) parts.push(dv.operator);
          if (dv.formulae?.length) parts.push(dv.formulae.join(', '));
          tags.push(`validation: ${parts.join(' ')}`);
        }
      }
      const displayVal = formatValue(raw);
      const tagStr = tags.length ? `  [${tags.join('] [')}]` : '';
      cells.push(`  ${ref}: ${displayVal}${tagStr}`);
    }
    if (cells.length === 0) {
      const hiddenTag = isHidden ? ' [hidden]' : '';
      lines.push(`--- Row ${r} (empty)${hiddenTag} ---`);
    } else {
      const rowBold = row.font?.bold ? ' [bold]' : '';
      const hiddenTag = isHidden ? ' [hidden]' : '';
      lines.push(`--- Row ${r}${rowBold}${hiddenTag} ---`);
      lines.push(...cells);
    }
  }

  if (opts.maxRows && ws.rowCount > endRow) {
    lines.push('');
    lines.push(`... ${ws.rowCount - endRow} more rows (truncated)`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown dump (LLM-friendly tables)
// ---------------------------------------------------------------------------

function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function dumpSheetMarkdown(ws, wb, opts = {}) {
  const { startRow, startCol, endRow, endCol } = selectionBounds(ws, opts);
  const out = [];
  out.push(`## ${ws.name}`);

  // Frontmatter context
  const meta = [];
  meta.push(`Range: ${colLetter(startCol)}${startRow}:${colLetter(endCol)}${endRow}`);
  meta.push(`Total: ${ws.rowCount} rows × ${ws.columnCount} cols`);
  const frozen = (ws.views || []).find(v => v.state === 'frozen');
  if (frozen) meta.push(`Frozen: row ${frozen.ySplit ?? 0}, col ${frozen.xSplit ?? 0}`);
  const merges = (ws.model && Array.isArray(ws.model.merges)) ? ws.model.merges : [];
  if (merges.length) meta.push(`Merged: ${merges.slice(0, 6).join(', ')}${merges.length > 6 ? ', ...' : ''}`);
  const namedRanges = getNamedRanges(wb, ws.name);
  if (namedRanges.length) meta.push(`Named ranges: ${namedRanges.map(n => n.name).join(', ')}`);
  out.push(`*${meta.join(' · ')}*`);
  out.push('');

  // Header detection: use first row in selection if it looks like text headers,
  // otherwise fall back to column letters.
  const firstRow = ws.getRow(startRow);
  const headers = [];
  let textHeaders = 0, totalHeaders = 0;
  for (let c = startCol; c <= endCol; c++) {
    const v = plainValue(firstRow.getCell(c).value);
    if (v != null && v !== '') {
      totalHeaders++;
      if (isNaN(parseFloat(v))) textHeaders++;
    }
    headers.push(v);
  }
  const useFirstRowAsHeader = totalHeaders > 0 && (textHeaders / totalHeaders) > 0.5;
  let dataStart = startRow;
  let cols;
  if (useFirstRowAsHeader) {
    cols = headers.map((h, i) => h != null && h !== '' ? String(h) : colLetter(startCol + i));
    dataStart = startRow + 1;
  } else {
    cols = [];
    for (let c = startCol; c <= endCol; c++) cols.push(colLetter(c));
  }

  // Render table
  out.push('| ' + cols.map(escapeMd).join(' | ') + ' |');
  out.push('|' + cols.map(() => '---').join('|') + '|');

  for (let r = dataStart; r <= endRow; r++) {
    const row = ws.getRow(r);
    const cells = [];
    let nonEmpty = 0;
    for (let c = startCol; c <= endCol; c++) {
      const v = plainValue(row.getCell(c).value);
      if (v != null && v !== '') nonEmpty++;
      // Wrap formulas in backticks so the model knows it's a formula
      const raw = row.getCell(c).value;
      if (raw && typeof raw === 'object' && (raw.formula || raw.sharedFormula)) {
        const display = v != null ? `${v} \`=${raw.formula || raw.sharedFormula}\`` : `\`=${raw.formula || raw.sharedFormula}\``;
        cells.push(escapeMd(display));
      } else {
        cells.push(escapeMd(v ?? ''));
      }
    }
    if (nonEmpty > 0) out.push('| ' + cells.join(' | ') + ' |');
  }

  if (opts.maxRows && ws.rowCount > endRow) {
    out.push('');
    out.push(`*... ${ws.rowCount - endRow} more rows truncated*`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// JSON dump
// ---------------------------------------------------------------------------

function jsonValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.hyperlink) return { text: v.text || v.hyperlink, hyperlink: v.hyperlink };
    if (v.formula || v.sharedFormula) {
      const out = {};
      if (v.formula) out.formula = v.formula;
      if (v.sharedFormula) out.sharedFormulaRef = v.sharedFormula;
      const result = v.result;
      if (result == null) out.result = null;
      else if (typeof result === 'object') {
        if (result.error) out.result = `#${result.error}`;
        else if (result.richText) out.result = result.richText.map(r => r.text).join('');
        else out.result = result;
      } else out.result = result;
      return out;
    }
    if (v.error) return `#${v.error}`;
  }
  return v;
}

function dumpSheetJSON(ws, wb, opts = {}) {
  const { startRow, startCol, endRow, endCol } = selectionBounds(ws, opts);

  const out = {
    name: ws.name,
    state: ws.state || 'visible',
    rowCount: ws.rowCount,
    columnCount: ws.columnCount,
    selection: { startRef: `${colLetter(startCol)}${startRow}`, endRef: `${colLetter(endCol)}${endRow}` },
    frozen: null,
    columns: [],
    hiddenColumns: [],
    hiddenRows: [],
    merges: (ws.model && Array.isArray(ws.model.merges)) ? ws.model.merges.slice() : [],
    autoFilter: null,
    printArea: null,
    namedRanges: getNamedRanges(wb, ws.name),
    tables: [],
    images: [],
    cells: [],
  };

  const frozen = (ws.views || []).find(v => v.state === 'frozen');
  if (frozen) out.frozen = { rowSplit: frozen.ySplit ?? 0, colSplit: frozen.xSplit ?? 0 };

  for (let c = startCol; c <= endCol; c++) {
    const col = ws.getColumn(c);
    const letter = colLetter(c);
    if (col.hidden) out.hiddenColumns.push(letter);
    out.columns.push({ letter, width: col.width || null, hidden: !!col.hidden });
  }
  // Some xlsx files set widths on columns past the populated range (e.g.,
  // columns reserved for future data, or styling-only columns). ExcelJS's
  // columnCount stops at populated cells, so a naive loop misses those widths
  // and they silently drop on round-trip. Walk ws.columns directly to pick up
  // any column metadata beyond endCol.
  try {
    const allCols = ws.columns || [];
    for (let i = endCol; i < allCols.length; i++) {
      const col = allCols[i];
      if (!col) continue;
      if (col.width != null || col.hidden) {
        const letter = colLetter(i + 1);
        if (col.hidden) out.hiddenColumns.push(letter);
        out.columns.push({ letter, width: col.width || null, hidden: !!col.hidden });
      }
    }
  } catch (_) {}

  if (ws.autoFilter) out.autoFilter = typeof ws.autoFilter === 'string' ? ws.autoFilter : (ws.autoFilter.ref || null);
  try { if (ws.pageSetup?.printArea) out.printArea = ws.pageSetup.printArea; } catch (_) {}

  try {
    const tableMap = ws.tables;
    if (tableMap && typeof tableMap === 'object') {
      const tables = typeof tableMap.forEach === 'function'
        ? (() => { const a = []; tableMap.forEach(t => a.push(t)); return a; })()
        : Object.values(tableMap);
      for (const t of tables) {
        const model = t.table || t.model || t;
        out.tables.push({
          name: model.name || model.displayName || null,
          ref: model.ref || model.tableRef || null,
          columns: (model.columns || []).map(c => c.name).filter(Boolean),
        });
      }
    }
  } catch (_) {}

  try {
    const images = typeof ws.getImages === 'function' ? ws.getImages() : [];
    for (const img of images) {
      if (img.range) {
        const tl = img.range.tl, br = img.range.br;
        out.images.push({
          tl: tl ? `${colLetter(Math.floor(tl.col)+1)}${Math.floor(tl.row)+1}` : null,
          br: br ? `${colLetter(Math.floor(br.col)+1)}${Math.floor(br.row)+1}` : null,
        });
      }
    }
  } catch (_) {}

  for (let r = startRow; r <= endRow; r++) {
    const row = ws.getRow(r);
    if (row.hidden) out.hiddenRows.push(r);
    for (let c = startCol; c <= endCol; c++) {
      const cell = row.getCell(c);
      const raw = cell.value;
      if (raw == null || raw === '') continue;
      const entry = { ref: `${colLetter(c)}${r}`, row: r, col: c, value: jsonValue(raw) };
      if (cell.numFmt && cell.numFmt !== 'General') entry.numFmt = cell.numFmt;
      if (cell.font?.bold) entry.bold = true;
      if (cell.font?.italic) entry.italic = true;
      if (cell.font?.color?.argb) entry.color = cell.font.color.argb;
      if (cell.fill?.type === 'pattern' && cell.fill.fgColor?.argb) entry.fill = cell.fill.fgColor.argb;
      if (cell.alignment?.horizontal && cell.alignment.horizontal !== 'general') entry.align = cell.alignment.horizontal;
      if (cell.hyperlink) entry.hyperlink = cell.hyperlink;
      if (cell.note) entry.note = describeNote(cell.note);
      if (cell.dataValidation) entry.dataValidation = cell.dataValidation;
      if (row.hidden) entry.rowHidden = true;
      out.cells.push(entry);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema inference (#5)
// ---------------------------------------------------------------------------

function inferType(values) {
  let n = 0, ints = 0, floats = 0, dates = 0, bools = 0, strs = 0, nulls = 0;
  for (const v of values) {
    if (v == null || v === '') { nulls++; continue; }
    n++;
    if (v instanceof Date) { dates++; continue; }
    if (typeof v === 'boolean') { bools++; continue; }
    if (typeof v === 'number') {
      if (Number.isInteger(v)) ints++; else floats++;
      continue;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^-?\d+$/.test(s)) { ints++; continue; }
      if (/^-?\d+\.\d+$/.test(s)) { floats++; continue; }
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) { dates++; continue; }
      if (/^(true|false)$/i.test(s)) { bools++; continue; }
      strs++; continue;
    }
    strs++;
  }
  if (n === 0) return { type: 'unknown', nullable: nulls > 0 };
  // Pick majority type
  const counts = { int: ints, float: floats, date: dates, bool: bools, str: strs };
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = sorted[0][0];
  const types = { int: 'INTEGER', float: 'NUMERIC', date: 'DATE', bool: 'BOOLEAN', str: 'TEXT' };
  return { type: types[top], nullable: nulls > 0, nonNull: n, total: n + nulls };
}

function inferSchema(ws, wb, opts = {}) {
  const { startRow, startCol, endRow, endCol } = selectionBounds(ws, opts);
  const headerRow = ws.getRow(startRow);
  const cols = [];
  for (let c = startCol; c <= endCol; c++) {
    const headerVal = plainValue(headerRow.getCell(c).value);
    const name = headerVal != null && headerVal !== '' ? String(headerVal) : colLetter(c);
    const sampleVals = [];
    for (let r = startRow + 1; r <= endRow && sampleVals.length < 200; r++) {
      const raw = ws.getRow(r).getCell(c).value;
      sampleVals.push(plainValue(raw));
    }
    const typeInfo = inferType(sampleVals);
    cols.push({
      name,
      column: colLetter(c),
      ...typeInfo,
      sample: sampleVals.filter(v => v != null && v !== '').slice(0, 3),
    });
  }
  return { sheet: ws.name, columns: cols };
}

// ---------------------------------------------------------------------------
// SQL export (#10)
// ---------------------------------------------------------------------------

function sqlIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function sqlVal(v, type) {
  if (v == null || v === '') return 'NULL';
  if (type === 'INTEGER' || type === 'NUMERIC') {
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  if (type === 'BOOLEAN') {
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return /^true$/i.test(String(v)) ? 'TRUE' : 'FALSE';
  }
  if (type === 'DATE') {
    if (v instanceof Date) return `'${v.toISOString().slice(0,10)}'`;
    return `'${String(v).slice(0,10)}'`;
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function dumpSheetSQL(ws, wb, opts = {}) {
  const schema = inferSchema(ws, wb, opts);
  const tableName = ws.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  const out = [];
  out.push(`-- Sheet: ${ws.name}`);
  out.push(`CREATE TABLE ${sqlIdent(tableName)} (`);
  const colDefs = schema.columns.map(c => `  ${sqlIdent(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`);
  out.push(colDefs.join(',\n'));
  out.push(');');
  out.push('');

  const { startRow, startCol, endRow, endCol } = selectionBounds(ws, opts);
  const colNames = schema.columns.map(c => sqlIdent(c.name)).join(', ');
  for (let r = startRow + 1; r <= endRow; r++) {
    const row = ws.getRow(r);
    const values = [];
    let hasAny = false;
    for (let i = 0; i < schema.columns.length; i++) {
      const c = startCol + i;
      const v = plainValue(row.getCell(c).value);
      if (v != null && v !== '') hasAny = true;
      values.push(sqlVal(v, schema.columns[i].type));
    }
    if (hasAny) {
      out.push(`INSERT INTO ${sqlIdent(tableName)} (${colNames}) VALUES (${values.join(', ')});`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Formula evaluation (#4) — pragmatic: promote cached results, optionally
// recompute simple literal/arithmetic formulas via formulajs.
// ---------------------------------------------------------------------------

function evaluateWorkbook(wb) {
  // Most .xlsx files saved by Excel/LibreOffice/etc. carry cached formula
  // results in cell.value.result. ExcelJS exposes those, so promotion is
  // mostly a no-op — formatValue already uses .result. The work this function
  // does is compute results for formulas that do NOT have a cached value
  // (typically machine-generated xlsx files). For these we attempt a simple
  // arithmetic eval using formulajs.
  const formulaJs = lazyFormulaJs();
  let computed = 0, missing = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (!v || typeof v !== 'object') return;
        if (!v.formula && !v.sharedFormula) return;
        if (v.result != null) return; // already cached
        const f = v.formula;
        if (!f) { missing++; return; }
        // Attempt: =SUM(literal,literal,...) or =A1+B1 (very narrow set)
        const m = /^([A-Z]+)\(([^()]+)\)$/i.exec(f);
        if (m) {
          const fn = m[1].toUpperCase();
          const args = m[2].split(',').map(s => parseFloat(s));
          if (typeof formulaJs[fn] === 'function' && args.every(Number.isFinite)) {
            try {
              const r = formulaJs[fn](...args);
              v.result = r;
              computed++;
              return;
            } catch (_) {}
          }
        }
        missing++;
      });
    });
  }
  return { computed, missing };
}

// ---------------------------------------------------------------------------
// Workbook diff (#7)
// ---------------------------------------------------------------------------

function diffWorkbooks(wbA, wbB, opts = {}) {
  const out = [];
  // Skip the tool's own report tab — it's metadata, not user data, so it
  // shouldn't show up as "added" or "changed" in user-facing diffs.
  const isReport = (name) => name === '_xlsx-for-ai';
  const sheetsA = new Map(wbA.worksheets.filter(s => !isReport(s.name)).map(s => [s.name, s]));
  const sheetsB = new Map(wbB.worksheets.filter(s => !isReport(s.name)).map(s => [s.name, s]));
  const allNames = new Set([...sheetsA.keys(), ...sheetsB.keys()]);

  for (const name of allNames) {
    const a = sheetsA.get(name);
    const b = sheetsB.get(name);
    if (!a) { out.push(`+ Sheet added: ${name}`); continue; }
    if (!b) { out.push(`- Sheet removed: ${name}`); continue; }
    out.push(`~ Sheet: ${name}`);
    const rows = Math.max(a.rowCount, b.rowCount);
    const cols = Math.max(a.columnCount, b.columnCount);
    let changes = 0;
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const va = plainValue(a.getRow(r).getCell(c).value);
        const vb = plainValue(b.getRow(r).getCell(c).value);
        if (va === vb) continue;
        const ref = `${colLetter(c)}${r}`;
        if (va == null && vb != null)      out.push(`  + ${ref}: ${escapeMd(vb)}`);
        else if (vb == null && va != null) out.push(`  - ${ref}: ${escapeMd(va)}`);
        else                                out.push(`  ~ ${ref}: ${escapeMd(va)} → ${escapeMd(vb)}`);
        changes++;
        if (opts.maxRows && changes >= opts.maxRows) {
          out.push(`  ... (more changes; raise --max-rows to see all)`);
          r = rows + 1; break;
        }
      }
    }
    if (changes === 0) out.push('  (no cell changes)');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Token budget (#2)
// ---------------------------------------------------------------------------

function applyTokenBudget(text, maxTokens) {
  const tk = lazyTokenizer();
  const totalTokens = tk.encode(text).length;
  if (totalTokens <= maxTokens) return text;
  // Truncate by lines (preserve table structure) until under budget.
  const lines = text.split('\n');
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = lines.slice(0, mid).join('\n');
    const ct = tk.encode(candidate).length;
    if (ct <= maxTokens - 60 /* leave room for tail summary */) lo = mid;
    else hi = mid - 1;
  }
  const kept = lines.slice(0, lo).join('\n');
  const droppedLines = lines.length - lo;
  return kept + `\n\n... [truncated to ~${maxTokens} tokens; ${droppedLines} of ${lines.length} lines / ${totalTokens} of ${totalTokens} input tokens dropped]`;
}

// ---------------------------------------------------------------------------
// Multi-format input (#3)
// ---------------------------------------------------------------------------

async function loadAnyWorkbook(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx') {
    return engine.loadWorkbook(filePath);
  }
  if (ext === '.csv' || ext === '.tsv') {
    const wb = engine.createWorkbook();
    const ws = wb.addWorksheet(path.basename(filePath, ext));
    const text = fs.readFileSync(filePath, 'utf8');
    const papa = lazyPapa();
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const parsed = papa.parse(text, { delimiter, skipEmptyLines: true });
    for (const row of parsed.data) ws.addRow(row);
    return wb;
  }
  if (ext === '.xls' || ext === '.xlsb' || ext === '.ods') {
    throw new Error(
      `Legacy format ${ext} is no longer supported. Convert to .xlsx first ` +
      `(e.g. open in Excel/LibreOffice and Save As .xlsx). See ` +
      `https://github.com/senoff/xlsx-for-ai/issues/26 for the discussion of ` +
      `whether to restore native support.`
    );
  }
  throw new Error(`Unsupported extension: ${ext}. Supported: .xlsx .csv .tsv`);
}

// ---------------------------------------------------------------------------
// Streaming (#9) — for files too large to fit in memory.
// Uses ExcelJS WorkbookReader; emits a simplified per-row text dump to stdout.
// ---------------------------------------------------------------------------

async function streamDump(filePath, opts) {
  const wb = engine.streamReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    worksheets: 'emit',
    styles: 'cache',
  });
  const sheetFilter = opts.positional[1] || null;
  let sheetIdx = 0;
  for await (const ws of wb) {
    sheetIdx++;
    const name = ws.name || `Sheet${sheetIdx}`;
    if (sheetFilter && name !== sheetFilter) continue;
    process.stdout.write(`=== Sheet: ${name} (streaming) ===\n`);
    let rowCount = 0;
    for await (const row of ws) {
      rowCount++;
      if (opts.maxRows && rowCount > opts.maxRows) {
        process.stdout.write(`... more rows truncated at --max-rows ${opts.maxRows}\n`);
        break;
      }
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (opts.maxCols && col > opts.maxCols) return;
        const ref = `${colLetter(col)}${row.number}`;
        // Streaming cells sometimes carry raw model objects; cell.text is the
        // already-rendered string and is more reliable here than cell.value.
        const display = (cell.text != null && cell.text !== '')
          ? `"${cell.text}"`
          : formatValue(cell.value);
        cells.push(`  ${ref}: ${display}`);
      });
      if (cells.length) {
        process.stdout.write(`--- Row ${row.number} ---\n` + cells.join('\n') + '\n');
      }
    }
    process.stdout.write('\n');
  }
}

// ---------------------------------------------------------------------------
// List sheets
// ---------------------------------------------------------------------------

function listSheets(wb) {
  const lines = [];
  for (const ws of wb.worksheets) {
    const vis = ws.state === 'hidden' ? ' [hidden]'
              : ws.state === 'veryHidden' ? ' [very hidden]' : '';
    lines.push(`${ws.name}  ${ws.rowCount} rows × ${ws.columnCount} cols${vis}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Write mode (#8) — JSON/markdown spec → .xlsx
//
// V1 scope: create-from-scratch only. Edit-in-place is deferred (ExcelJS would
// need to round-trip every detail of an existing file, which it doesn't do
// faithfully — that's a separate effort using xlsx-populate or a patch engine).
//
// Accepted inputs:
//   - JSON: strict subset of our --json output (round-trips). Either a
//     single-sheet object or {sheets: [...]} for multi-sheet.
//   - Markdown: one or more tables; "## Sheet Name" headings split into
//     multiple sheets. No headings = single sheet.
//   - '-' as the spec path: read spec from stdin (format auto-detected).
// ---------------------------------------------------------------------------

function parseWriteArgs(argv) {
  const opts = { positional: [], output: null, noReport: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if      (a === '-h' || a === '--help')    opts.help = true;
    else if (a === '-o' || a === '--output')  opts.output = argv[++i];
    else if (a === '--no-report')             opts.noReport = true;
    else                                        opts.positional.push(a);
    i++;
  }
  return opts;
}

function printWriteHelp() {
  console.log(`Usage: xlsx-for-ai write <spec> [-o output.xlsx]

Builds an .xlsx file from a spec. Spec formats:
  - JSON     — strict subset of xlsx-for-ai's --json output (round-trips)
  - Markdown — one or more tables; "## Sheet Name" headings split sheets
  - '-'      — read spec from stdin (format auto-detected by first non-blank char)

Options:
  -o, --output PATH   Output xlsx path (default: <spec basename>.xlsx)
  --no-report         Suppress the "_xlsx-for-ai" review tab (advanced; for
                      pipelines that want byte-clean output without metadata)
  -h, --help          Show this help

Examples:
  xlsx-for-ai write spec.json
  xlsx-for-ai write spec.json -o report.xlsx
  xlsx-for-ai write report.md
  cat spec.json | xlsx-for-ai write -

JSON spec — minimum (single sheet):
  {
    "name": "Budget",
    "headers": ["Category", "Q1", "Q2"],
    "rows": [
      ["Marketing", 10000, 12000],
      ["R&D", 50000, 55000]
    ]
  }

JSON spec — multi-sheet:
  { "sheets": [ {...}, {...} ], "namedRanges": {"Totals": "Sheet1!B2:C5"} }

JSON spec — formulas:
  rows can include { "formula": "=SUM(B2:B5)" } in place of a literal value.
  cells can be specified explicitly: { "cells": [{ "ref": "B6", "value": {"formula": "=SUM(B2:B5)"} }] }

Optional fields per sheet: numberFormat, columnWidths, frozen, merges, autoFilter.

Not supported in v1: edit-in-place, charts, pivot tables, conditional formatting,
images, macros. Use a sidecar instructions file for those for now.`);
}

// Strip a string for value coercion: "42" → 42, "true" → true, "2026-04-27" → Date.
function coerceMarkdownValue(c) {
  if (c == null || c === '') return null;
  // Backtick-fenced formula: `=SUM(A1:A10)`
  const fm = /^`\s*(=.+?)\s*`$/.exec(c);
  if (fm) return { formula: fm[1].replace(/^=/, '') };
  if (/^-?\d+$/.test(c)) return parseInt(c, 10);
  if (/^-?\d+\.\d+$/.test(c)) return parseFloat(c);
  if (/^(true|false)$/i.test(c)) return /^true$/i.test(c);
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return new Date(c);
  return c.replace(/\\\|/g, '|');
}

function parseMarkdownSpec(text) {
  // Walk the doc, accumulating lines per "## Heading" section. Each section
  // that contains a markdown table becomes a sheet.
  const sections = [];
  let currentName = null;
  let currentLines = [];
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (currentLines.some(l => l.trim().startsWith('|'))) {
        sections.push({ name: currentName, lines: currentLines });
      }
      currentName = m[1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.some(l => l.trim().startsWith('|'))) {
    sections.push({ name: currentName, lines: currentLines });
  }
  if (sections.length === 0) {
    throw new Error('No markdown table found in input');
  }

  const sheets = sections.map(({ name, lines }, idx) => {
    const tableLines = lines
      .map(l => l.trim())
      .filter(l => l.startsWith('|') && l.endsWith('|'));
    if (tableLines.length < 2) {
      throw new Error(`Sheet "${name || `Sheet${idx+1}`}": no markdown table found`);
    }
    const cells = tableLines.map(l =>
      l.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim())
    );
    const sepIdx = cells.findIndex(row =>
      row.length > 0 && row.every(c => /^:?-+:?$/.test(c))
    );
    if (sepIdx < 1) throw new Error(`Sheet "${name || `Sheet${idx+1}`}": missing markdown header separator`);
    const headers = cells[sepIdx - 1];
    const rows = cells.slice(sepIdx + 1).map(row =>
      row.map(c => coerceMarkdownValue(c))
    );
    return { name: name || `Sheet${idx+1}`, headers, rows };
  });

  return { sheets };
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Spec must be an object');
  // Single-sheet shortcut: top-level looks like a sheet → wrap.
  if ((Array.isArray(spec.rows) || Array.isArray(spec.cells)) && !Array.isArray(spec.sheets)) {
    spec = { sheets: [spec] };
  }
  // Array form (--json output for multi-sheet) → wrap.
  if (Array.isArray(spec)) {
    spec = { sheets: spec };
  }
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    throw new Error('Spec needs at least one sheet (top-level "sheets" array, or single-sheet "rows"/"cells")');
  }
  const names = new Set();
  for (const s of spec.sheets) {
    if (!s.name) throw new Error('Each sheet needs a "name"');
    if (names.has(s.name)) throw new Error(`Duplicate sheet name: "${s.name}"`);
    names.add(s.name);
    if (!Array.isArray(s.rows) && !Array.isArray(s.cells)) {
      throw new Error(`Sheet "${s.name}": needs "rows" array or "cells" array`);
    }
    if (Array.isArray(s.rows) && !Array.isArray(s.headers)) {
      // headers are optional; if absent, first row is treated as data.
      // No error.
    }
  }
  return spec;
}

function trySimpleEval(formula) {
  const f = formula.replace(/^=/, '');
  const m = /^([A-Z]+)\(([^()]+)\)$/i.exec(f);
  if (!m) return null;
  const fn = m[1].toUpperCase();
  const args = m[2].split(',').map(s => parseFloat(s));
  if (!args.every(Number.isFinite)) return null;
  const fjs = lazyFormulaJs();
  if (typeof fjs[fn] !== 'function') return null;
  try { return fjs[fn](...args); } catch (_) { return null; }
}

// JSON serialization turns Date instances into ISO strings, so on the way back
// in from a spec we re-coerce ISO-shaped strings to Date — but only the shapes
// that JSON.stringify(Date) actually produces. The signature of a Date-derived
// string is the trailing Z (UTC); user-typed timestamp strings typically carry
// a timezone offset like "-07:00", so we leave those alone.
function coerceMaybeDate(v) {
  if (typeof v !== 'string') return v;
  // Pure date: "2019-01-01"
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d;
  }
  // ISO with explicit UTC Z (what JSON.stringify(Date) produces for any Date)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d;
  }
  return v;
}

function buildCellValue(v, lossyOut) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.formula) {
      const out = { formula: v.formula.replace(/^=/, '') };
      if (v.result !== undefined) out.result = coerceMaybeDate(v.result);
      else {
        const r = trySimpleEval(v.formula);
        if (r != null) out.result = r;
      }
      return out;
    }
    // Shared-formula followers: --json output emits these as
    // { sharedFormulaRef: "B5", result: <cached> }. ExcelJS can't reconstruct
    // a shared-formula follower from just a ref (it'd need the master expression
    // and relative-reference shifting). Pragmatic v1 behavior: degrade to the
    // cached result as a plain value. The cell's displayed value is preserved;
    // the formula link is lost.
    if (v.sharedFormulaRef || v.sharedFormula) {
      if (lossyOut) lossyOut.sharedFormula = (lossyOut.sharedFormula || 0) + 1;
      if (v.result === undefined) return null;
      return coerceMaybeDate(v.result);
    }
    if (v.hyperlink) {
      return { text: v.text || v.hyperlink, hyperlink: v.hyperlink };
    }
    return v;
  }
  // CRLF-in-string detection: ExcelJS normalizes \r\n → \n in shared-string
  // serialization. Visible content unchanged, but worth warning so users with
  // byte-exact pipelines aren't surprised.
  if (typeof v === 'string' && v.includes('\r') && lossyOut) {
    lossyOut.crlf = (lossyOut.crlf || 0) + 1;
  }
  return coerceMaybeDate(v);
}

function applyCellStyle(cell, c) {
  if (c.numFmt) cell.numFmt = c.numFmt;
  if (c.bold || c.italic || c.color) {
    cell.font = {};
    if (c.bold)   cell.font.bold = true;
    if (c.italic) cell.font.italic = true;
    if (c.color)  cell.font.color = { argb: c.color };
  }
  if (c.fill) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.fill } };
  }
  if (c.align) {
    cell.alignment = { horizontal: c.align };
  }
}

function applyNumberFormat(ws, ref, fmt) {
  // "A:A" or "A:D" — whole columns
  const colMatch = /^([A-Z]+):([A-Z]+)$/i.exec(ref);
  if (colMatch) {
    const c1 = colNum(colMatch[1]);
    const c2 = colNum(colMatch[2]);
    for (let c = c1; c <= c2; c++) ws.getColumn(c).numFmt = fmt;
    return;
  }
  if (ref.includes(':')) {
    const r = parseRange(ref);
    for (let row = r.startRow; row <= r.endRow; row++) {
      for (let col = r.startCol; col <= r.endCol; col++) {
        ws.getCell(`${colLetter(col)}${row}`).numFmt = fmt;
      }
    }
  } else {
    ws.getCell(ref).numFmt = fmt;
  }
}

function buildWorkbook(spec) {
  const wb = engine.createWorkbook();
  const warnings = []; // [{type, sheet, ref}, ...]

  function track(sheetName, ref, lossy) {
    if (lossy.sharedFormula) warnings.push({ type: 'sharedFormula', sheet: sheetName, ref });
    if (lossy.crlf)          warnings.push({ type: 'crlf',          sheet: sheetName, ref });
  }

  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);

    if (sheet.frozen) {
      ws.views = [{
        state: 'frozen',
        xSplit: sheet.frozen.colSplit ?? sheet.frozen.xSplit ?? 0,
        ySplit: sheet.frozen.rowSplit ?? sheet.frozen.ySplit ?? 0,
      }];
    }

    if (sheet.columnWidths && typeof sheet.columnWidths === 'object') {
      for (const [letter, width] of Object.entries(sheet.columnWidths)) {
        try { ws.getColumn(colNum(letter)).width = width; } catch (_) {}
      }
    }
    // Also read widths from the `columns` array — that's the shape `--json`
    // output produces (`columns: [{letter, width, hidden}, ...]`). Without
    // this, round-tripping a workbook through `--json` → `write` silently
    // dropped all column widths, breaking the documented round-trip claim.
    if (Array.isArray(sheet.columns)) {
      for (const col of sheet.columns) {
        if (!col || !col.letter) continue;
        try {
          const c = ws.getColumn(colNum(col.letter));
          if (col.width != null) c.width = col.width;
          if (col.hidden) c.hidden = true;
        } catch (_) {}
      }
    }

    if (Array.isArray(sheet.cells)) {
      // Per-cell mode (round-trip from --json). cells: [{ref, value, ...style}, ...]
      for (const c of sheet.cells) {
        if (!c.ref) continue;
        const cell = ws.getCell(c.ref);
        const lossy = {};
        cell.value = buildCellValue(c.value, lossy);
        track(sheet.name, c.ref, lossy);
        applyCellStyle(cell, c);
      }
    } else {
      // Tabular mode (markdown / simple JSON). headers (optional) + rows.
      let rowIdx = 1;
      if (Array.isArray(sheet.headers) && sheet.headers.length > 0) {
        const hdrRow = ws.getRow(rowIdx);
        sheet.headers.forEach((h, i) => {
          const cell = hdrRow.getCell(i + 1);
          cell.value = h;
          cell.font = { bold: true };
        });
        rowIdx++;
      }
      for (const r of sheet.rows) {
        const row = ws.getRow(rowIdx);
        if (Array.isArray(r)) {
          r.forEach((v, i) => {
            const lossy = {};
            row.getCell(i + 1).value = buildCellValue(v, lossy);
            if (lossy.sharedFormula || lossy.crlf) {
              track(sheet.name, `${colLetter(i+1)}${rowIdx}`, lossy);
            }
          });
        } else if (r && typeof r === 'object') {
          // Object form: { col1: val, col2: val }, keyed by header name.
          if (Array.isArray(sheet.headers)) {
            sheet.headers.forEach((h, i) => {
              if (r[h] !== undefined) {
                const lossy = {};
                row.getCell(i + 1).value = buildCellValue(r[h], lossy);
                if (lossy.sharedFormula || lossy.crlf) {
                  track(sheet.name, `${colLetter(i+1)}${rowIdx}`, lossy);
                }
              }
            });
          }
        }
        rowIdx++;
      }
    }

    if (sheet.numberFormat && typeof sheet.numberFormat === 'object') {
      for (const [ref, fmt] of Object.entries(sheet.numberFormat)) {
        try { applyNumberFormat(ws, ref, fmt); } catch (_) {}
      }
    }

    // Restore hidden-row state from --json round-trip. Without this, the
    // `hiddenRows: [...]` field emitted on read is silently dropped on write,
    // breaking the round-trip claim for fixtures like annotations.xlsx.
    if (Array.isArray(sheet.hiddenRows)) {
      for (const n of sheet.hiddenRows) {
        if (typeof n === 'number' && n >= 1) {
          try { ws.getRow(n).hidden = true; } catch (_) {}
        }
      }
    }

    if (Array.isArray(sheet.merges)) {
      for (const m of sheet.merges) {
        try { ws.mergeCells(m); } catch (_) {}
      }
    }

    if (sheet.autoFilter) {
      ws.autoFilter = sheet.autoFilter;
    }

    // Sheet-level named ranges (the shape --json output produces:
    // [{name, ranges: ["Sheet1!$A$1:$D$10"]}, ...])
    if (Array.isArray(sheet.namedRanges)) {
      for (const nr of sheet.namedRanges) {
        if (!nr.name || !Array.isArray(nr.ranges)) continue;
        for (const ref of nr.ranges) {
          try { wb.definedNames.add(ref, nr.name); } catch (_) {}
        }
      }
    }
  }

  // Workbook-level named ranges (concise spec form: { "Totals": "Sheet1!B2:C5" })
  if (spec.namedRanges && typeof spec.namedRanges === 'object' && !Array.isArray(spec.namedRanges)) {
    for (const [name, ref] of Object.entries(spec.namedRanges)) {
      try { wb.definedNames.add(ref, name); } catch (_) {}
    }
  }
  // Workbook-level array form (also from --json)
  if (Array.isArray(spec.namedRanges)) {
    for (const nr of spec.namedRanges) {
      if (!nr.name || !Array.isArray(nr.ranges)) continue;
      for (const ref of nr.ranges) {
        try { wb.definedNames.add(ref, nr.name); } catch (_) {}
      }
    }
  }

  return { wb, warnings };
}

// Per-issue review templates. Each entry follows the "supervisor leaves a
// review note" shape: what happened, what we did, the risk, the tradeoff, and
// how to override. Keeps the user in the decision seat.
const REPORT_REVIEWS = {
  sharedFormula: {
    title: 'Shared formula degradation',
    whatHappened:
      "The source file used Excel's shared-formula optimization — one master cell carries the formula, follower cells reference the master. ExcelJS cannot reconstruct that link in the output file.",
    whatWeDid:
      'Each follower cell was replaced with its cached numeric value. You will see the same numbers in Excel as before; the formula link itself is gone.',
    risk:
      'If you edit any cell the original formula depended on, the previously-shared cells will not recalculate — they are now hardcoded numbers, not formulas.',
    tradeoff:
      'Smaller file, but the spreadsheet is "frozen": adding rows or changing inputs will not propagate the way they used to.',
    alternative:
      'Rerun with --fix-shared-formulas=expand (planned for v1.5). Each follower becomes an explicit per-cell formula — slightly larger file, but each cell recalculates independently like hand-written formulas. Closest behavior to the original source.',
  },
  crlf: {
    title: 'CRLF → LF line-ending normalization',
    whatHappened:
      'The source file had Windows-style CRLF line endings (\\r\\n) inside cell text. ExcelJS normalizes these to Unix-style LF (\\n) when writing shared strings.',
    whatWeDid:
      'Each affected cell\'s text now uses LF instead of CRLF. Visible content is identical — Excel, Numbers, and LibreOffice render both the same way.',
    risk:
      'No risk to the spreadsheet content itself. Only matters if a downstream tool does byte-exact comparison or specifically processes \\r\\n (e.g., greps for Windows-encoded text).',
    tradeoff:
      'None visible in spreadsheet apps. The output is also marginally smaller.',
    alternative:
      'If your pipeline requires CRLF preservation, pre-process source strings to substitute a placeholder before extracting --json, then restore after writing. Or simply ignore — this is the most cosmetic of the round-trip artifacts.',
  },
};

// Add a "_xlsx-for-ai" tab to the workbook with a review-style report of any
// round-trip lossy events. Embedded in the file (not just stderr) so the
// feedback travels with the workbook. Each issue type gets a full review note
// (what happened, what we did, risk, tradeoff, alternative) so the user can
// understand the decisions and override if they prefer different behavior.
function addReportSheet(wb, warnings) {
  if (warnings.length === 0) return;

  const ws = wb.addWorksheet('_xlsx-for-ai');

  // Header rows
  ws.getCell('A1').value = 'xlsx-for-ai write report';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.mergeCells('A1:D1');

  ws.getCell('A2').value = `Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
  ws.mergeCells('A2:D2');

  ws.getCell('A3').value =
    'This file passed through xlsx-for-ai write. The sections below describe what changed during the round-trip, why, and how to override if you want different behavior. Cell values you see in the rest of the workbook are correct — these notes describe structural changes (formulas, line endings, etc.) that may matter for future edits.';
  ws.getCell('A3').font = { italic: true, color: { argb: 'FF666666' } };
  ws.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
  ws.mergeCells('A3:D3');
  ws.getRow(3).height = 60;

  // Group warnings by type
  const byType = {};
  for (const w of warnings) (byType[w.type] = byType[w.type] || []).push(w);

  let r = 5;

  // Per-issue review block
  for (const [type, group] of Object.entries(byType)) {
    const review = REPORT_REVIEWS[type] || {
      title: type,
      whatHappened: 'Unspecified round-trip change.',
      whatWeDid: '(no template available)',
      risk: '(unknown)',
      tradeoff: '(unknown)',
      alternative: '(none)',
    };

    // Issue heading bar
    ws.getCell(`A${r}`).value = `Issue: ${review.title}  (${group.length} cell${group.length === 1 ? '' : 's'})`;
    ws.getCell(`A${r}`).font = { bold: true, size: 12 };
    ws.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F0F8' } };
    ws.mergeCells(`A${r}:D${r}`);
    r++;

    const addProse = (label, body) => {
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { bold: true };
      ws.getCell(`A${r}`).alignment = { vertical: 'top', wrapText: true };
      ws.getCell(`B${r}`).value = body;
      ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
      ws.mergeCells(`B${r}:D${r}`);
      // Approximate height: ~6 chars per Excel "row unit" given an 80-char column,
      // 15px per row unit baseline. Capped at a reasonable max.
      const lines = Math.max(2, Math.ceil(body.length / 95));
      ws.getRow(r).height = Math.min(lines * 15, 120);
      r++;
    };

    addProse('What happened', review.whatHappened);
    addProse('What we did',   review.whatWeDid);
    addProse('Risk',          review.risk);
    addProse('Tradeoff',      review.tradeoff);
    addProse('Alternative',   review.alternative);

    // Compact "affected cells" summary
    const cellList = group.map(w => `${w.sheet}!${w.ref}`);
    const cellSummary = cellList.length <= 10
      ? cellList.join(', ')
      : `${cellList.slice(0, 10).join(', ')}, ... and ${cellList.length - 10} more (full list at the bottom of this sheet)`;
    addProse('Affected cells', cellSummary);

    // Spacer row between issue blocks
    r++;
  }

  // Full detail table
  ws.getCell(`A${r}`).value = 'Full detail (one row per affected cell)';
  ws.getCell(`A${r}`).font = { bold: true, size: 12 };
  ws.mergeCells(`A${r}:D${r}`);
  r++;

  ws.getCell(`A${r}`).value = 'Sheet';
  ws.getCell(`B${r}`).value = 'Cell';
  ws.getCell(`C${r}`).value = 'Issue type';
  ws.getCell(`D${r}`).value = 'Title';
  ['A','B','C','D'].forEach(c => {
    ws.getCell(`${c}${r}`).font = { bold: true };
    ws.getCell(`${c}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  });
  r++;

  const MAX_DETAIL = 1000;
  const detailRows = warnings.slice(0, MAX_DETAIL);
  for (const w of detailRows) {
    ws.getCell(`A${r}`).value = w.sheet;
    ws.getCell(`B${r}`).value = w.ref;
    ws.getCell(`C${r}`).value = w.type;
    ws.getCell(`D${r}`).value = (REPORT_REVIEWS[w.type] && REPORT_REVIEWS[w.type].title) || w.type;
    r++;
  }
  if (warnings.length > MAX_DETAIL) {
    ws.getCell(`A${r}`).value = `... and ${warnings.length - MAX_DETAIL} more (totals shown in the issue blocks above)`;
    ws.getCell(`A${r}`).font = { italic: true };
    ws.mergeCells(`A${r}:D${r}`);
  }

  // Column widths
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 80;
}

function readStdinAll() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readSpecText(specPath) {
  if (specPath === '-') return readStdinAll();
  if (!fs.existsSync(specPath)) {
    throw new Error(`Spec file not found: ${specPath}`);
  }
  return fs.readFileSync(specPath, 'utf8');
}

async function loadSpec(specPath) {
  const text = await readSpecText(specPath);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch (e) { throw new Error(`Spec is not valid JSON: ${e.message}`); }
    return parsed;
  }
  return parseMarkdownSpec(text);
}

async function mainWrite(argv) {
  const opts = parseWriteArgs(argv);
  if (opts.help) { printWriteHelp(); process.exit(0); }
  if (opts.positional.length < 1) { printWriteHelp(); process.exit(1); }

  const specPath = opts.positional[0];

  let spec;
  try {
    spec = await loadSpec(specPath);
    spec = validateSpec(spec);
  } catch (e) {
    console.error(`Spec error: ${e.message}`);
    process.exit(1);
  }

  let wb, warnings;
  try {
    ({ wb, warnings } = buildWorkbook(spec));
  } catch (e) {
    console.error(`Build error: ${e.message}`);
    process.exit(1);
  }

  // Embed a review-style report tab in the file when there are round-trip
  // warnings, so the feedback travels with the workbook for the human or agent
  // that opens it. `--no-report` suppresses for pipelines that don't want the
  // extra sheet (e.g. round-trip CI tests).
  if (!opts.noReport) {
    addReportSheet(wb, warnings);
  }

  let outPath = opts.output;
  if (!outPath) {
    if (specPath === '-') outPath = 'output.xlsx';
    else outPath = path.basename(specPath, path.extname(specPath)) + '.xlsx';
  }
  outPath = path.resolve(outPath);

  try {
    await engine.writeWorkbook(wb, outPath);
  } catch (e) {
    console.error(`Write error: ${e.message}`);
    process.exit(1);
  }
  console.log(outPath);
  if (warnings.length > 0) {
    console.error(`note: ${warnings.length} round-trip warning(s) written to '_xlsx-for-ai' sheet in the output.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);

  // --version / -v: short-circuit before any file parsing so users can ask
  // the version without it being treated as a filename. Mirrors --help.
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(require('./package.json').version);
    process.exit(0);
  }

  // Sub-command dispatch
  if (argv[0] === 'write') return mainWrite(argv.slice(1));

  const opts = parseArgs(argv);

  if (opts.help) { printHelp(); process.exit(0); }

  // ---------------------------------------------------------------------------
  // Telemetry management flags — handled before crash hooks are registered.
  // ---------------------------------------------------------------------------
  if (opts.enableTelemetry || opts.disableTelemetry || opts.telemetryStatus) {
    const telCfg = require('./lib/telemetry-config');

    if (opts.enableTelemetry) {
      telCfg.enableTelemetry();
      console.log('Crash telemetry enabled.');
      console.log('');
      console.log('When a crash occurs, this payload will be sent:');
      console.log(JSON.stringify({
        v: 1,
        ts: '<ISO-timestamp>',
        error_type: '<e.g. TypeError>',
        error_message: '<sanitized, ≤200 chars — paths scrubbed>',
        command: '<first CLI arg from allowlist, or "<other>">',
        xlsx_for_ai_version: require('./package.json').version,
        node_version: process.version,
        os_arch: `${process.platform}-${process.arch}`,
      }, null, 2));
      console.log('');
      console.log('No paths, no cell values, no identifiers. Consent stored at:');
      console.log(telCfg.configPath());
      return;
    }

    if (opts.disableTelemetry) {
      telCfg.disableTelemetry();
      console.log('Crash telemetry disabled.');
      console.log('Config kept at: ' + telCfg.configPath());
      return;
    }

    if (opts.telemetryStatus) {
      const status = telCfg.telemetryStatus();
      console.log(`Telemetry status: ${status}`);
      console.log(`Config path:      ${telCfg.configPath()}`);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Register process-level crash hooks (no-op if user hasn't opted in).
  // ---------------------------------------------------------------------------
  {
    const { registerCrashHooks } = require('./lib/telemetry-hooks');
    registerCrashHooks(require('./package.json').version);
  }

  // Bug-report and redacted-workbook modes consume their input via the
  // flag itself, so they bypass the normal positional / loader path.
  if (opts.reportBug) {
    const { generateBugReport, writeBugReport } = require('./lib/bugReport');
    const inputPath = path.resolve(opts.reportBug);
    const report = await generateBugReport(inputPath);
    const outPath = writeBugReport(report, process.cwd());
    console.log(outPath);
    return;
  }
  if (opts.exportRedactedWorkbook) {
    const { exportRedactedWorkbook } = require('./lib/redactWorkbook');
    const inputPath = path.resolve(opts.exportRedactedWorkbook);
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const outPath = path.join(path.dirname(inputPath), `${base}-redacted${ext}`);
    await exportRedactedWorkbook(inputPath, outPath);
    console.log(outPath);
    return;
  }

  if (opts.positional.length < 1) { printHelp(); process.exit(1); }

  const filePath = path.resolve(opts.positional[0]);
  const sheetFilter = opts.positional[1] || null;

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    console.error(`File is empty (0 bytes), not a valid spreadsheet: ${filePath}`);
    process.exit(1);
  }
  // Min 22 bytes (zip EOCD) only meaningful for binary formats; CSV/TSV can be smaller.
  const ext = path.extname(filePath).toLowerCase();
  const isBinary = ext === '.xlsx';
  if (isBinary && stat.size < 22) {
    console.error(`File is too small (${stat.size} bytes) to be a valid spreadsheet: ${filePath}`);
    process.exit(1);
  }

  // Streaming mode: bypass full-workbook load.
  if (opts.stream) {
    if (ext !== '.xlsx') {
      console.error(`--stream only supports .xlsx (got ${ext})`);
      process.exit(1);
    }
    await streamDump(filePath, opts);
    return;
  }

  let wb;
  try {
    wb = await loadAnyWorkbook(filePath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`Failed to read ${filePath}: ${msg}`);
    if (/End of data reached|Corrupted zip|invalid signature/i.test(msg)) {
      console.error('Hint: file may be truncated or not a real spreadsheet. Try opening it in Excel to confirm.');
    } else if (/Cannot read propert/i.test(msg)) {
      console.error('Hint: file parsed as a zip but a workbook part is malformed. Try --list-sheets for a lighter probe.');
    } else if (/Unsupported extension/.test(msg)) {
      console.error('Hint: rename or convert to a supported extension.');
    }
    process.exit(1);
  }

  // Diff mode
  if (opts.diff) {
    const otherPath = path.resolve(opts.diff);
    if (!fs.existsSync(otherPath)) {
      console.error(`Diff target not found: ${otherPath}`);
      process.exit(1);
    }
    const wbB = await loadAnyWorkbook(otherPath);
    const out = diffWorkbooks(wb, wbB, opts);
    if (opts.maxTokens) process.stdout.write(applyTokenBudget(out, opts.maxTokens) + '\n');
    else process.stdout.write(out + '\n');
    return;
  }

  // --list-sheets
  if (opts.listSheets) {
    console.log(listSheets(wb));
    return;
  }

  // --evaluate: promote cached results / compute simple formulas.
  if (opts.evaluate) {
    const r = evaluateWorkbook(wb);
    if (process.env.XLSX_FOR_AI_DEBUG) console.error(`evaluate: computed=${r.computed} missing=${r.missing}`);
  }

  // Resolve --named-range to a sheet+bounds; overrides sheetFilter if provided.
  let sheets;
  let perSheetOpts = { ...opts };
  if (opts.namedRange) {
    const resolved = resolveNamedRange(wb, opts.namedRange);
    if (!resolved) {
      console.error(`Named range "${opts.namedRange}" not found.`);
      process.exit(1);
    }
    const ws = wb.getWorksheet(resolved.sheet);
    if (!ws) {
      console.error(`Named range references sheet "${resolved.sheet}" which is missing.`);
      process.exit(1);
    }
    sheets = [ws];
    perSheetOpts.namedRangeBounds = resolved.range;
  } else {
    sheets = sheetFilter
      ? [wb.getWorksheet(sheetFilter)].filter(Boolean)
      : wb.worksheets;
  }

  if (sheets.length === 0) {
    if (sheetFilter) {
      console.error(`Sheet "${sheetFilter}" not found. Available: ${wb.worksheets.map(s => s.name).join(', ')}`);
    } else {
      console.error('No sheets in workbook.');
      console.error('Hint: this can happen when a non-Excel tool wrote the file with backslashes in zip entry paths (e.g. xl\\worksheets\\sheet1.xml). ExcelJS only recognizes forward-slash entries.');
    }
    process.exit(1);
  }

  const baseName = path.basename(filePath, path.extname(filePath));

  // --region: warn per-sheet if no data block was found (empty sheet).
  if (opts.region) {
    for (const ws of sheets) {
      const r = detectRegion(ws);
      if (!r) {
        console.error(`note: --region: no data found in sheet "${ws.name}"; dumping full sheet dimensions.`);
      }
    }
  }

  // Pick output formatter.
  const renderText  = (ws) => dumpSheet(ws, wb, perSheetOpts);
  const renderMd    = (ws) => dumpSheetMarkdown(ws, wb, perSheetOpts);
  const renderJSON  = (ws) => dumpSheetJSON(ws, wb, perSheetOpts);
  const renderSQL   = (ws) => dumpSheetSQL(ws, wb, perSheetOpts);
  const renderSchema = (ws) => inferSchema(ws, wb, perSheetOpts);

  // Schema mode (always JSON-shaped, may be array)
  if (opts.schema) {
    const payload = sheets.map(renderSchema);
    const json = JSON.stringify(sheets.length === 1 ? payload[0] : payload, null, 2);
    const final = opts.maxTokens ? applyTokenBudget(json, opts.maxTokens) : json;
    if (opts.stdout) { process.stdout.write(final + '\n'); return; }
    const outDir = path.join(process.cwd(), '.xlsx-read');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${baseName}--schema.json`);
    fs.writeFileSync(outFile, final, 'utf8');
    console.log(outFile);
    return;
  }

  // SQL mode
  if (opts.sql) {
    const text = sheets.map(renderSQL).join('\n\n');
    const final = opts.maxTokens ? applyTokenBudget(text, opts.maxTokens) : text;
    if (opts.stdout) { process.stdout.write(final + '\n'); return; }
    const outDir = path.join(process.cwd(), '.xlsx-read');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${baseName}.sql`);
    fs.writeFileSync(outFile, final, 'utf8');
    console.log(outFile);
    return;
  }

  // JSON mode
  if (opts.json) {
    const payload = sheets.map(renderJSON);
    const json = JSON.stringify(sheets.length === 1 ? payload[0] : payload, null, 2);
    const final = opts.maxTokens ? applyTokenBudget(json, opts.maxTokens) : json;
    if (opts.stdout) { process.stdout.write(final + '\n'); return; }
    const outDir = path.join(process.cwd(), '.xlsx-read');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${baseName}.json`);
    fs.writeFileSync(outFile, final, 'utf8');
    console.log(outFile);
    return;
  }

  // Markdown mode
  if (opts.md) {
    const text = sheets.map(renderMd).join('\n\n');
    const final = opts.maxTokens ? applyTokenBudget(text, opts.maxTokens) : text;
    if (opts.stdout) { process.stdout.write(final + '\n'); return; }
    const outDir = path.join(process.cwd(), '.xlsx-read');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${baseName}.md`);
    fs.writeFileSync(outFile, final, 'utf8');
    console.log(outFile);
    return;
  }

  // Default: text dump
  if (opts.stdout) {
    let combined = '';
    for (const ws of sheets) combined += renderText(ws) + '\n\n';
    const final = opts.maxTokens ? applyTokenBudget(combined, opts.maxTokens) : combined;
    process.stdout.write(final);
    return;
  }
  const outDir = path.join(process.cwd(), '.xlsx-read');
  fs.mkdirSync(outDir, { recursive: true });
  for (const ws of sheets) {
    const content = renderText(ws);
    const final = opts.maxTokens ? applyTokenBudget(content, opts.maxTokens) : content;
    const safeName = ws.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outFile = path.join(outDir, `${baseName}--${safeName}.txt`);
    fs.writeFileSync(outFile, final, 'utf8');
    console.log(outFile);
  }
}

// Run as CLI when invoked directly. Skip when imported so tests can require
// this module and exercise its internals without triggering main().
if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error(msg);
    if (/Invalid string length/i.test(msg)) {
      console.error('Hint: this sheet renders to a text dump larger than V8\'s 512MB string limit. Try --max-rows N, --max-cols N, --max-tokens N, --range A1:..., or --stream.');
    }
    process.exit(1);
  });
}

// Export internals for unit tests. Production CLI use never touches these
// exports — this is only for `require('./index.js')` in test files.
module.exports = {
  // arg parsing
  parseArgs,
  parseWriteArgs,
  // pure utilities
  colLetter,
  colNum,
  parseRange,
  isDefaultTextColor,
  describeFill,
  describeFont,
  formatValue,
  plainValue,
  jsonValue,
  describeNote,
  escapeMd,
  coerceMaybeDate,
  coerceMarkdownValue,
  // schema/format
  inferType,
  sqlIdent,
  sqlVal,
  // spec parsing
  parseMarkdownSpec,
  validateSpec,
  buildCellValue,
  // workbook builders
  buildWorkbook,
  trySimpleEval,
  // budget
  applyTokenBudget,
  // region detection
  detectRegion,
  selectionBounds,
};
