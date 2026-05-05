'use strict';

/**
 * Local read-mode fallback for xlsx_read.
 *
 * Used when the hosted API is unreachable (5xx or timeout).
 * Lazy-loads @protobi/exceljs — catches the require error and emits a
 * clear message if it isn't installed.
 *
 * Returns the same shape as the API: { content: [{ type: 'text', text }], _meta }
 */

const fs   = require('fs');
const path = require('path');

function requireEngine() {
  try {
    return require('@protobi/exceljs');
  } catch (_) {
    const e = new Error(
      'Local fallback requires `npm install @protobi/exceljs` ' +
      '(this is normally not needed when the hosted API is available).'
    );
    e.code = 'FALLBACK_ENGINE_MISSING';
    throw e;
  }
}

async function fallbackRead(filePath, options = {}) {
  const ExcelJS = requireEngine();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const lines = [];
  wb.eachSheet((sheet) => {
    lines.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        vals.push(cell.text != null ? String(cell.text) : '');
      });
      lines.push(vals.join('\t'));
    });
    lines.push('');
  });

  const text = lines.join('\n');
  return {
    content: [{ type: 'text', text }],
    _meta: { source: 'local-fallback', engine: '@protobi/exceljs', file: path.basename(filePath) },
  };
}

module.exports = { fallbackRead };
