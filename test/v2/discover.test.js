'use strict';

/**
 * Tests for lib/discover.js — dynamic tool catalog resolution.
 *
 * Covers:
 *   - mergeTools: server wins on collision; baked-in fills gaps
 *   - resolveCatalog: remote success path writes cache + returns merged set
 *   - resolveCatalog: remote failure + fresh cache => uses cache
 *   - resolveCatalog: remote failure + no cache => uses static fallback
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

// Hermetic config dir so tests don't touch the developer's real cache.
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-discover-test-'));
process.env.XFA_CONFIG_DIR = TMP_CFG;
// Point the API at a definitely-unreachable host for the negative tests.
process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:1';  // port 1 = guaranteed no listener

const { resolveCatalog, _internal } = require('../../lib/discover');

const STATIC_FALLBACK = [
  { name: 'xlsx_read',       description: 'baked read' },
  { name: 'xlsx_list_sheets', description: 'baked list' },
];

test('mergeTools: server wins on name collision; baked-in fills gaps', () => {
  const remote = [
    { name: 'xlsx_read',  description: 'remote read v2' },
    { name: 'xlsx_brand_new', description: 'a new server-side tool' },
  ];
  const baked = [
    { name: 'xlsx_read',        description: 'baked read v1' },
    { name: 'xlsx_list_sheets', description: 'baked only' },
  ];
  const merged = _internal.mergeTools(remote, baked);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].name, 'xlsx_read');
  assert.equal(merged[0].description, 'remote read v2', 'server description wins');
  assert.equal(merged[1].name, 'xlsx_brand_new', 'new server tool surfaces');
  assert.equal(merged[2].name, 'xlsx_list_sheets', 'baked-only tool preserved');
});

test('resolveCatalog: remote unreachable + no cache => static fallback', async () => {
  // Make sure no cache file exists for this run.
  try { fs.unlinkSync(_internal.cachePath()); } catch (_) {}
  const out = await resolveCatalog(STATIC_FALLBACK);
  assert.equal(out.source, 'static');
  assert.deepEqual(out.tools.map(t => t.name).sort(),
                   STATIC_FALLBACK.map(t => t.name).sort());
});

test('resolveCatalog: remote unreachable + fresh cache => uses cache', async () => {
  _internal.writeCache([
    { name: 'xlsx_read',     description: 'cached' },
    { name: 'xlsx_cached_only', description: 'only in cache' },
  ]);
  const out = await resolveCatalog(STATIC_FALLBACK);
  assert.equal(out.source, 'cache', `expected fresh-cache source, got ${out.source}`);
  const names = out.tools.map(t => t.name);
  assert.ok(names.includes('xlsx_cached_only'), 'cache-only tool surfaces');
  assert.ok(names.includes('xlsx_list_sheets'), 'baked-only tool still surfaces as floor');
});

test('resolveCatalog: stale cache still wins over baked-only fallback', async () => {
  // Write a cache, then artificially backdate it past TTL.
  _internal.writeCache([{ name: 'xlsx_only_in_stale_cache', description: 'old but real' }]);
  const cachePath = _internal.cachePath();
  const obj = JSON.parse(require('node:fs').readFileSync(cachePath, 'utf8'));
  obj.fetched_at = Date.now() - (48 * 60 * 60 * 1000);  // 48h old; TTL is 24h
  require('node:fs').writeFileSync(cachePath, JSON.stringify(obj));
  const out = await resolveCatalog(STATIC_FALLBACK);
  assert.equal(out.source, 'cache-stale', 'stale cache must beat static fallback');
  const names = out.tools.map(t => t.name);
  assert.ok(names.includes('xlsx_only_in_stale_cache'), 'cache contents preserved');
  assert.ok(names.includes('xlsx_read'), 'baked floor still surfaces');
});

test('mergeTools: tolerates malformed baked entries without crashing', () => {
  const remote = [{ name: 'xlsx_read', description: 'remote' }];
  const baked = [
    null,
    { name: 'xlsx_dup', description: 'd1' },
    { name: 'xlsx_dup', description: 'd2' },  // duplicate name in baked
    { description: 'no name field' },
    'a string',
    { name: 'xlsx_keep', description: 'keep' },
  ];
  const merged = _internal.mergeTools(remote, baked);
  const names = merged.map(t => t.name);
  assert.deepEqual(names, ['xlsx_read', 'xlsx_dup', 'xlsx_keep']);
});
