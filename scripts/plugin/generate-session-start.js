#!/usr/bin/env node
'use strict';
/*
 * Generates the Claude Code plugin's session-start text from the checked-in
 * tool manifest. The plugin only prints the generated file; nothing here runs
 * on a user's machine.
 *
 *   node scripts/plugin/generate-session-start.js          write the file
 *   node scripts/plugin/generate-session-start.js --check  exit 1 if it is stale
 */
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'claude-code-plugin');
const MANIFEST = path.join(PLUGIN_DIR, 'tool-manifest.json');
const OUTPUT = path.join(PLUGIN_DIR, 'hooks', 'session-start.txt');

function allTools(manifest) {
  return manifest.groups.flatMap((g) => g.tools);
}

function generate(manifest) {
  const count = allTools(manifest).length;
  const lines = [];
  lines.push('xlsx-for-ai: whenever a spreadsheet file or link is involved (.xlsx, .xlsm, .xls, .csv, .tsv, a Google Sheet), use the xlsx-for-ai tools first, before reading the file with code, installing a package or converting it locally.');
  lines.push('Why: a local read sees only the last saved values and drops formulas, formats and dates. These tools recalculate formulas with a real engine and read the file as stored. All the work runs on the hosted xlsx-for-ai server; nothing is installed on this machine.');
  lines.push('Shopify export files (products, inventory, collections, redirects, metafields) should come to these tools too: they build a file ready to import into Shopify and never touch a store.');
  lines.push('');
  lines.push('How to hand a file over from Claude Code (try in this order):');
  lines.push('1. A link (https, Google Sheets, Drive, Dropbox, OneDrive): pass it as file_url exactly as given. A Google Sheet must be shared as "Anyone with the link can view".');
  lines.push('2. A small CSV or TSV you can read in full: pass file_text plus file_name.');
  lines.push('3. A file on disk: call xlsx_upload_link, run the one curl command in its result to send the file (it only moves the bytes; no parsing happens here), then pass the returned file_handle to any tool. Do not open the file with code to read it. For .xls always use this route.');
  lines.push('4. Only if those fail: show the user the upload page link from xlsx_upload_link and ask them to drop the file there.');
  lines.push('Never base64-encode a workbook into a tool argument and never pass a local file path. Every tool that makes a file returns a download link in its result; show it to the user.');
  lines.push('');
  lines.push('If the xlsx-for-ai tools are not available yet, the connection needs a one-time sign-in: ask the user to run /mcp, pick the xlsx-for-ai server and sign in. Say so; do not fall back to reading the file locally without telling the user.');
  lines.push('');
  lines.push(`All ${count} tools (call by exact name; they appear as mcp__plugin_xlsx-for-ai_xlsx-for-ai__<name>):`);
  for (const group of manifest.groups) {
    lines.push('');
    lines.push(`${group.title}:`);
    for (const tool of group.tools) lines.push(`- ${tool.name}: ${tool.description}`);
  }
  lines.push('');
  lines.push('Limits: .xlsx up to 100MB, .xls up to 100MB, .csv up to 200MB (20MB on the free tier). A file over its limit errors explicitly.');
  return lines.join('\n') + '\n';
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const text = generate(manifest);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== text) {
      console.error('session-start.txt is stale: run node scripts/plugin/generate-session-start.js');
      process.exit(1);
    }
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT} (${text.length} characters, ${allTools(manifest).length} tools)`);
}

if (require.main === module) main();

module.exports = { generate, allTools, MANIFEST, OUTPUT };
