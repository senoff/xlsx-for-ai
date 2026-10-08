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
 * Commerce tools (importable_, printful_, printify_, shopify_) are dropped
 * except the 12 file-in, file-out shopify_* tools the door serves, the same
 * allowlist the server uses (src/mcp/claude-manifest.ts). xlsx_upload_link is served by the door itself
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
// The commerce tools the door serves (server CLAUDE_DOOR_COMMERCE_TOOLS): file in, file out only.
const SERVED_COMMERCE = [
  'shopify_products_import', 'shopify_products_import_fix', 'shopify_collections_import',
  'shopify_inventory_import', 'shopify_url_redirects_import', 'shopify_metafields_safe_reimport',
  'shopify_variant_metafields_import', 'shopify_product_metafields_import',
  'shopify_google_feed', 'shopify_amazon_feed', 'shopify_ebay_feed', 'shopify_ups_feed',
];
const DOOR_LOCAL = ['xlsx_upload_link'];

function firstSentence(text) {
  const s = String(text || '').split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  return (s.length > 110 ? s.slice(0, 107) + '...' : s).replace(/\.$/, '').replace(/[^\x20-\x7e]/g, '-');
}

function refresh(manifest, list) {
  const served = new Map(
    list.filter((t) => SERVED_COMMERCE.includes(t.name) || !COMMERCE_PREFIXES.some((p) => t.name.startsWith(p))).map((t) => [t.name, t]),
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

const TOOL_NAME = /^[a-z0-9_]+$/;

// Bounded fetch: 10 s per attempt, 3 attempts, 500 ms / 1 s backoff. Node >= 22 (package.json engines) has global fetch.
async function fetchJson(url, attempts = 3, timeoutMs = 10000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`could not fetch ${url} after ${attempts} attempts: ${last && last.message}`);
}

function validateList(list) {
  if (!Array.isArray(list)) throw new Error('tool list is not an array');
  for (const t of list) {
    if (!t || typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) {
      throw new Error(`unexpected tool name: ${JSON.stringify(t && t.name)}`);
    }
  }
  return list;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const usage = () => {
    console.error('usage: refresh-tool-manifest.js --file tools-list.json | --url <tools list URL>');
    process.exit(2);
  };
  let body;
  try {
    if (args.includes('--file')) {
      if (!get('--file')) usage();
      body = JSON.parse(fs.readFileSync(get('--file'), 'utf8'));
    } else if (args.includes('--url')) {
      if (!get('--url')) usage();
      body = await fetchJson(get('--url'));
    } else usage();
  } catch (e) {
    console.error(`refresh-tool-manifest: ${e.message}`);
    process.exit(3);
  }
  let list;
  try {
    list = validateList(Array.isArray(body) ? body : body.tools);
  } catch (e) {
    console.error(`refresh-tool-manifest: ${e.message}`);
    process.exit(3);
  }
  const { manifest, added, removed } = refresh(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), list);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`added: ${added.join(', ') || 'none'}\nremoved: ${removed.join(', ') || 'none'}`);
  if (added.length) console.log('Edit the new entries in "Other tools", then run generate-session-start.js.');
}

if (require.main === module) main();

module.exports = { refresh, firstSentence, validateList, fetchJson };
