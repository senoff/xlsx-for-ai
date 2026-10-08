#!/usr/bin/env node
'use strict';
/*
 * Refreshes claude-code-plugin/tool-manifest.json when the server adds or
 * removes a tool.
 *
 *   node scripts/plugin/refresh-tool-manifest.js --file tools-list.json
 *   node scripts/plugin/refresh-tool-manifest.js --url https://api.xlsx-for-ai.dev/api/v1/tools/list
 *
 * Input is the server's public tool list ({ tools: [{ name, description }] }).
 * Commerce tools (importable_, printful_, printify_, shopify_) are not served
 * by the plugin's endpoint and are dropped, the same filter the server uses
 * (src/mcp/claude-manifest.ts). xlsx_upload_link is served by the door itself
 * and is not in that list, so it is always kept.
 *
 * Tools that vanished are removed. New tools are appended to a group named
 * "Other tools" with the first sentence of the server description; edit the
 * wording and move them into the right group by hand, then run
 * generate-session-start.js. The test suite fails until you do.
 */
const fs = require('node:fs');
const { MANIFEST, allTools } = require('./generate-session-start.js');

const COMMERCE_PREFIXES = ['importable_', 'printful_', 'printify_', 'shopify_'];
const DOOR_LOCAL = ['xlsx_upload_link'];

function firstSentence(text) {
  const s = String(text || '').split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  return (s.length > 110 ? s.slice(0, 107) + '...' : s).replace(/\.$/, '').replace(/[^\x20-\x7e]/g, '-');
}

function refresh(manifest, list) {
  const served = new Map(
    list.filter((t) => !COMMERCE_PREFIXES.some((p) => t.name.startsWith(p))).map((t) => [t.name, t]),
  );
  for (const name of DOOR_LOCAL) served.set(name, served.get(name) || { name, description: '' });
  const known = new Set(allTools(manifest).map((t) => t.name));
  const removed = [...known].filter((n) => !served.has(n));
  const added = [...served.keys()].filter((n) => !known.has(n));
  for (const g of manifest.groups) g.tools = g.tools.filter((t) => served.has(t.name));
  manifest.groups = manifest.groups.filter((g) => g.tools.length > 0 || g.title === 'Other tools');
  if (added.length) {
    let other = manifest.groups.find((g) => g.title === 'Other tools');
    if (!other) manifest.groups.push((other = { title: 'Other tools', tools: [] }));
    for (const n of added) other.tools.push({ name: n, description: firstSentence(served.get(n).description) });
  }
  return { manifest, added, removed };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  let body;
  if (get('--file')) body = JSON.parse(fs.readFileSync(get('--file'), 'utf8'));
  else if (get('--url')) body = await (await fetch(get('--url'))).json();
  else {
    console.error('usage: refresh-tool-manifest.js --file tools-list.json | --url <tools list URL>');
    process.exit(2);
  }
  const list = Array.isArray(body) ? body : body.tools;
  const { manifest, added, removed } = refresh(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), list);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`added: ${added.join(', ') || 'none'}\nremoved: ${removed.join(', ') || 'none'}`);
  if (added.length) console.log('Edit the new entries in "Other tools", then run generate-session-start.js.');
}

if (require.main === module) main();

module.exports = { refresh, firstSentence };
