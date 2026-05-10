'use strict';

/**
 * Dynamic tool catalog discovery.
 *
 * At MCP server startup we ask the hosted API "what tools do you support?" so
 * new server-side tools appear in users' agents WITHOUT us re-publishing the
 * npm package or re-signing the .mcpb. The thin client stays thin; the catalog
 * lives where the tools live.
 *
 * Endpoint: GET ${apiBase}/api/v1/tools/list
 *   -> { tools: [{ name, description, inputSchema, ... }, ...], version? }
 *
 * Behaviour:
 *   - Fetch with a short timeout (3s — startup-blocking, must not hang an agent).
 *   - On success: cache to ~/.xlsx-for-ai/tools-cache.json with TTL.
 *   - On failure (404, network, timeout): use the cache if fresh; else use the
 *     baked-in static fallback the caller passes in.
 *   - The local fallback is the floor, NEVER the ceiling. Server > cache > static.
 *
 * Why dynamic: today every new server-side tool requires a TOOLS array edit +
 * version bump + npm publish + (post-Phase 4.5) .mcpb rebuild + Anthropic
 * directory re-review. With dynamic discovery the only release vehicle is the
 * server deploy. See ~/xlsx-for-ai-internal/ROADMAP.md Phase 4.5.
 */

const fs   = require('fs');
const path = require('path');

const { apiBase } = require('./client');
const { configPath } = require('./config');

const DISCOVER_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;  // 24h

function cachePath() {
  // Co-locate with config.json so XFA_CONFIG_DIR override works for tests.
  return path.join(path.dirname(configPath()), 'tools-cache.json');
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.tools) || typeof obj.fetched_at !== 'number') return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function writeCache(tools) {
  try {
    const dir = path.dirname(cachePath());
    fs.mkdirSync(dir, { recursive: true });
    const payload = { fetched_at: Date.now(), tools };
    fs.writeFileSync(cachePath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (_) {
    // Cache write failures are non-fatal — the next startup just re-fetches.
  }
}

function isCacheFresh(entry) {
  return entry && (Date.now() - entry.fetched_at) < CACHE_TTL_MS;
}

async function fetchRemoteCatalog() {
  const url = apiBase() + '/api/v1/tools/list';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = new Error(`tools/list returned HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.tools)) {
    throw new Error('tools/list response missing tools array');
  }
  return body.tools;
}

/**
 * mergeTools: server catalog wins on name collision; baked-in tools fill gaps.
 * Order: every remote tool first (preserving server order), then any baked-in
 * tool whose name isn't in the remote set. This way the most up-to-date
 * description always wins, but we never lose a tool the client knows how to
 * dispatch even if the server temporarily forgets it.
 */
function mergeTools(remote, baked) {
  const out = [];
  const seen = new Set();
  for (const t of remote) {
    if (!t || typeof t.name !== 'string') continue;
    out.push(t);
    seen.add(t.name);
  }
  for (const t of baked) {
    if (!t || typeof t.name !== 'string') continue;  // tolerate malformed baked entries
    if (seen.has(t.name)) continue;
    out.push(t);
    seen.add(t.name);  // dedupe within baked too
  }
  return out;
}

/**
 * Resolve the tool catalog the MCP server should expose.
 *
 * @param {Array} bakedFallback - the static TOOLS array embedded in the package
 * @returns {Promise<{tools: Array, source: string}>}
 *   source ∈ 'remote' | 'cache' | 'cache-stale' | 'static'
 */
async function resolveCatalog(bakedFallback) {
  // 1. Try remote. On success, cache and merge.
  try {
    const remote = await fetchRemoteCatalog();
    writeCache(remote);
    return { tools: mergeTools(remote, bakedFallback), source: 'remote' };
  } catch (err) {
    // fall through
  }

  // 2. Fresh cache wins over baked.
  const cache = readCache();
  if (isCacheFresh(cache)) {
    return { tools: mergeTools(cache.tools, bakedFallback), source: 'cache' };
  }

  // 3. Stale cache STILL wins over baked. The cache represents what the
  //    server said last time we could reach it; that's by definition more
  //    authoritative than what was hardcoded into this client version. The
  //    baked-in TOOLS still get merged in as the floor — mergeTools dedupes
  //    by name with cache entries winning, so users never lose a tool that
  //    used to be available even if the server temporarily forgets it.
  if (cache) {
    return { tools: mergeTools(cache.tools, bakedFallback), source: 'cache-stale' };
  }

  // 4. Last resort: the baked-in fallback.
  return { tools: bakedFallback, source: 'static' };
}

module.exports = {
  resolveCatalog,
  // exported for tests
  _internal: { mergeTools, readCache, writeCache, cachePath, fetchRemoteCatalog },
};
