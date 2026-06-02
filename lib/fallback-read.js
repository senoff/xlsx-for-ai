'use strict';

/**
 * Local read-mode fallback for xlsx_read.
 *
 * Used when the hosted API is unreachable (5xx or timeout).
 * Lazy-loads @protobi/exceljs — catches the require error and emits a
 * clear message if it isn't installed.
 *
 * Returns the same shape as the API: { content: [{ type: 'text', text }], _meta }
 *
 * Asymmetry vs. the hosted API (callers should be aware):
 *   - options.sheet IS honored — the response is filtered to the named sheet.
 *   - options.format is NOT honored — fallback always emits plain text.
 *   - options.evaluate is NOT honored — formulas render as the cached values
 *     stored in the workbook, not re-evaluated by a formula engine.
 *
 * When any option is passed and ignored, a visible warning is prepended to
 * the text content AND the ignored option names are echoed back via
 * _meta.ignored_options. Callers can detect fallback unambiguously via
 * _meta.source === 'local-fallback'.
 */

const path = require('path');

function requireEngine() {
  try {
    return require('@protobi/exceljs');
  } catch (e) {
    // Only translate the "module not installed" case. A real bug inside the
    // engine (syntax error, transitive missing dep, etc.) must surface as the
    // original error, not get misreported as a missing-install.
    const isModuleNotFound =
      e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes('@protobi/exceljs');
    if (!isModuleNotFound) throw e;
    const err = new Error(
      'Local fallback requires `npm install @protobi/exceljs` ' +
      '(this is normally not needed when the hosted API is available).'
    );
    err.code = 'FALLBACK_ENGINE_MISSING';
    throw err;
  }
}

// @protobi/exceljs's cell.text getter throws on merge cells whose master
// value is null — produced by SEC XBRL→xlsx converters and probably any
// other tool that writes merge regions before populating the master cell.
// The thrown shape is `TypeError: Cannot read properties of null (reading
// 'toString')` from inside the MergeValue / value getter chain. Guard the
// access so one cell of one sheet can't crash the entire dump, but only
// swallow the exact null-deref TypeError class — anything else (a real
// bug in the engine, a structural surprise we haven't characterized)
// rethrows so we don't silently render data as empty.
function safeCellText(cell) {
  try {
    const t = cell.text;
    return t != null ? String(t) : '';
  } catch (e) {
    // Match V8's exact "Cannot read property/properties of null/undefined"
    // shape, not just any TypeError whose message happens to contain "null"
    // or "undefined" (which would falsely swallow legitimate engine errors
    // like "argument must not be undefined"). Coerce message to string
    // first so a TypeError with no message can't crash the handler itself.
    const msg = typeof e?.message === 'string' ? e.message : '';
    const isNullishPropDeref = e instanceof TypeError &&
      /^Cannot read (?:property|properties) of (?:null|undefined)\b/.test(msg);
    if (isNullishPropDeref) return '';
    throw e;
  }
}

async function fallbackRead(filePath, options = {}) {
  const ExcelJS = requireEngine();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const requestedSheet = options.sheet || null;
  // Detect presence (not truthiness) so the caller's intent is honored even
  // for falsy-but-passed values like format:'' or evaluate:false.
  const ignoredOptions = [];
  if ('format' in options)   ignoredOptions.push('format');
  if ('evaluate' in options) ignoredOptions.push('evaluate');

  const lines = [];
  const warningParts = ['⚠ API unreachable — local fallback active.'];
  if (ignoredOptions.length > 0) {
    warningParts.push(`Options not honored by fallback: ${ignoredOptions.join(', ')}.`);
  }
  lines.push(warningParts.join(' '));
  lines.push('');

  let sheetMatched = false;
  wb.eachSheet((sheet) => {
    if (requestedSheet && sheet.name !== requestedSheet) return;
    sheetMatched = true;
    lines.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        vals.push(safeCellText(cell));
      });
      lines.push(vals.join('\t'));
    });
    lines.push('');
  });

  if (requestedSheet && !sheetMatched) {
    const available = wb.worksheets.map((s) => s.name);
    lines.push(
      available.length === 0
        ? `(no sheet named "${requestedSheet}" — workbook has no sheets)`
        : `(no sheet named "${requestedSheet}" — workbook has: ${available.join(', ')})`
    );
  }

  const text = lines.join('\n');
  return {
    content: [{ type: 'text', text }],
    _meta: {
      source: 'local-fallback',
      engine: '@protobi/exceljs',
      file: path.basename(filePath),
      sheet_filter: requestedSheet,
      ignored_options: ignoredOptions,
    },
  };
}

module.exports = { fallbackRead };
