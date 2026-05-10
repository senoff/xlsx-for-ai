'use strict';

/**
 * Tests for lib/discover.js — dynamic tool catalog resolution.
 *
 * Covers:
 *   - mergeTools: server wins on collision; baked-in fills gaps; dedupes both
 *     sides; tolerates malformed entries
 *   - resolveCatalog happy path: remote success writes cache + returns merged set
 *   - resolveCatalog negative: remote unreachable falls back to fresh cache,
 *     stale cache, then static (in that order)
 *   - isCacheFresh: rejects future timestamps (clock-skew defense)
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

// Hermetic config dir so tests don't touch the developer's real cache.
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-discover-test-'));
const PRIOR_ENV = {
  XFA_CONFIG_DIR: process.env.XFA_CONFIG_DIR,
  XLSX_FOR_AI_API: process.env.XLSX_FOR_AI_API,
};
process.env.XFA_CONFIG_DIR = TMP_CFG;
// Point the API at a definitely-unreachable host for the negative tests.
process.env.XLSX_FOR_AI_API = 'http://127.0.0.1:1';  // port 1 = guaranteed no listener

test.after(() => {
  // Restore env so other test files in the same runner aren't tainted.
  if (PRIOR_ENV.XFA_CONFIG_DIR === undefined) delete process.env.XFA_CONFIG_DIR;
  else process.env.XFA_CONFIG_DIR = PRIOR_ENV.XFA_CONFIG_DIR;
  if (PRIOR_ENV.XLSX_FOR_AI_API === undefined) delete process.env.XLSX_FOR_AI_API;
  else process.env.XLSX_FOR_AI_API = PRIOR_ENV.XLSX_FOR_AI_API;
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

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

test('mergeTools: dedupes within remote; first occurrence wins', () => {
  const remote = [
    { name: 'xlsx_dup', description: 'first wins' },
    { name: 'xlsx_dup', description: 'second loses' },
    { name: 'xlsx_only', description: 'kept' },
  ];
  const merged = _internal.mergeTools(remote, []);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].description, 'first wins');
});

test('mergeTools: tolerates malformed entries on both sides', () => {
  const remote = [
    null,
    { description: 'no name field' },
    { name: 'xlsx_read', description: 'remote' },
  ];
  const baked = [
    null,
    { name: 'xlsx_dup', description: 'b1' },
    { name: 'xlsx_dup', description: 'b2' },
    { description: 'no name' },
    'a string',
    { name: 'xlsx_keep', description: 'keep' },
  ];
  const merged = _internal.mergeTools(remote, baked);
  assert.deepEqual(merged.map(t => t.name), ['xlsx_read', 'xlsx_dup', 'xlsx_keep']);
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
  _internal.writeCache([{ name: 'xlsx_only_in_stale_cache', description: 'old but real' }]);
  const cp = _internal.cachePath();
  const obj = JSON.parse(fs.readFileSync(cp, 'utf8'));
  obj.fetched_at = Date.now() - (48 * 60 * 60 * 1000);  // 48h old; TTL is 24h
  fs.writeFileSync(cp, JSON.stringify(obj));
  const out = await resolveCatalog(STATIC_FALLBACK);
  assert.equal(out.source, 'cache-stale', 'stale cache must beat static fallback');
  const names = out.tools.map(t => t.name);
  assert.ok(names.includes('xlsx_only_in_stale_cache'), 'cache contents preserved');
  assert.ok(names.includes('xlsx_read'), 'baked floor still surfaces');
});

test('resolveCatalog: future-timestamped cache is not treated as fresh', async () => {
  // Defense against clock skew or cache-file tampering. A future fetched_at
  // would otherwise produce a negative age, which is always less than TTL,
  // pinning the cache forever.
  const cp = _internal.cachePath();
  fs.writeFileSync(cp, JSON.stringify({
    fetched_at: Date.now() + (10 * 60 * 60 * 1000),  // 10h in the future
    tools: [{ name: 'xlsx_future_cached', description: 'tampered' }],
  }));
  const out = await resolveCatalog(STATIC_FALLBACK);
  assert.equal(out.source, 'cache-stale',
               `future cache must not be treated as fresh; got ${out.source}`);
});

test('resolveCatalog: remote success writes cache and returns source=remote', async () => {
  // Stash and stub global fetch so we can simulate a successful catalog
  // without standing up an HTTP server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url) => ({
    ok: true,
    status: 200,
    json: async () => ({
      tools: [
        { name: 'xlsx_dynamic_only', description: 'lives only on the server' },
        { name: 'xlsx_read',         description: 'remote-fresh description' },
      ],
    }),
  });
  // Clear any prior cache so we can verify the write path.
  try { fs.unlinkSync(_internal.cachePath()); } catch (_) {}
  try {
    const out = await resolveCatalog(STATIC_FALLBACK);
    assert.equal(out.source, 'remote');
    const names = out.tools.map(t => t.name);
    assert.ok(names.includes('xlsx_dynamic_only'), 'remote-only tool surfaces');
    assert.ok(names.includes('xlsx_list_sheets'),  'baked floor still merged in');
    // Verify cache was written so a subsequent failed run can fall back to it.
    const cached = JSON.parse(fs.readFileSync(_internal.cachePath(), 'utf8'));
    assert.equal(cached.tools[0].name, 'xlsx_dynamic_only');
    assert.equal(typeof cached.fetched_at, 'number');
  } finally {
    globalThis.fetch = realFetch;
  }
});
