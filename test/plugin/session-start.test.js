'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, allTools, MANIFEST, OUTPUT } = require('../../scripts/plugin/generate-session-start.js');

const ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const COMMERCE_PREFIXES = ['importable_', 'printful_', 'printify_', 'shopify_'];

test('the checked-in session-start text equals the generated text', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'utf8'), generate(manifest));
});

test('every manifest tool appears by exact name in the text, and no other tool name does', () => {
  const text = fs.readFileSync(OUTPUT, 'utf8');
  const names = allTools(manifest).map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in manifest');
  for (const n of names) assert.ok(text.includes(`- ${n}: `), `missing ${n}`);
  const listed = [...text.matchAll(/^- ([a-z_]+): /gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...names].sort());
  assert.ok(text.includes(`All ${names.length} tools`));
});

// The commerce tools the hosted door serves (server PR XLS-2591, CLAUDE_DOOR_COMMERCE_TOOLS):
// file in, import-ready file out; the door never connects to a store or supplier account.
const SERVED_COMMERCE = [
  'shopify_products_import', 'shopify_products_import_fix', 'shopify_collections_import',
  'shopify_inventory_import', 'shopify_url_redirects_import', 'shopify_metafields_safe_reimport',
  'shopify_variant_metafields_import', 'shopify_product_metafields_import',
  'shopify_google_feed', 'shopify_amazon_feed', 'shopify_ebay_feed', 'shopify_ups_feed',
];

test('only the 12 served commerce tools, none of the store or supplier tools; descriptions present; no "Other tools" left unedited', () => {
  for (const t of allTools(manifest)) {
    const commerce = COMMERCE_PREFIXES.some((p) => t.name.startsWith(p));
    assert.ok(!commerce || SERVED_COMMERCE.includes(t.name), `commerce tool the door does not serve: ${t.name}`);
    assert.ok(t.description && t.description.length > 3, `no description for ${t.name}`);
  }
  assert.ok(!manifest.groups.some((g) => g.title === 'Other tools'), 'move new tools out of "Other tools"');
});

test('the Shopify group lists exactly the served commerce tools and the text points Shopify files at them', () => {
  const group = manifest.groups.find((g) => /^Shopify and store exports/.test(g.title));
  assert.ok(group, 'missing Shopify and store exports group');
  assert.deepEqual(group.tools.map((t) => t.name).sort(), [...SERVED_COMMERCE].sort());
  const names = allTools(manifest).map((t) => t.name).filter((n) => COMMERCE_PREFIXES.some((p) => n.startsWith(p)));
  assert.deepEqual(names.sort(), [...SERVED_COMMERCE].sort());
  const text = fs.readFileSync(OUTPUT, 'utf8');
  const lines = text.split('\n');
  assert.ok(lines.findIndex((l) => /^Shopify export files \(products, inventory, collections, redirects, metafields\)/.test(l)) < 6, 'Shopify line is not near the top');
  assert.match(text, /build a file ready to import into Shopify and never touch a store/);
});

test('text is plain ASCII, under 7000 characters, first two lines carry the rule', () => {
  const text = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(text.length <= 7000, `length ${text.length}`);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(text), 'non-ASCII character in text');
  const [l1, l2] = text.split('\n');
  assert.match(l1, /\.xlsx, \.xlsm, \.xls, \.csv, \.tsv, a Google Sheet/);
  assert.match(l1, /before reading the file with code, installing a package or converting it locally/);
  assert.match(l2, /last saved values and drops formulas, formats and dates/);
  assert.ok(!/microsoft/i.test(text));
});

test('plugin files are text and pointers only', () => {
  const dir = path.join(ROOT, 'claude-code-plugin');
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  for (const s of Object.values(mcp.mcpServers)) {
    assert.equal(s.type, 'http');
    assert.match(s.url, /^https:\/\/api\.xlsx-for-ai\.dev\/mcp$/);
    assert.equal(s.command, undefined);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.SessionStart[0];
  assert.equal(entry.matcher, 'startup|resume|clear|compact');
  assert.match(entry.hooks[0].command, /^cat "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/session-start\.txt"$/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.ok(!/\.(js|mjs|cjs|ts|py|sh|ps1|exe|node|wasm)$/.test(f), `code file shipped in plugin: ${f}`);
});

test('skill description is within the truncation limit and lists the paths', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'claude-code-plugin', 'skills', 'spreadsheets', 'SKILL.md'), 'utf8');
  const desc = /^description: (.*)$/m.exec(skill)[1];
  assert.ok(desc.length < 1536);
  for (const ext of ['xlsx', 'xlsm', 'xls', 'csv', 'tsv']) assert.ok(skill.includes(`"**/*.${ext}"`));
});

test('marketplace points at the plugin directory', () => {
  const mk = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mk.plugins[0].source, './claude-code-plugin');
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-code-plugin', '.claude-plugin', 'plugin.json')));
});
