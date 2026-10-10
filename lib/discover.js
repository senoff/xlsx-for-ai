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

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { apiBase } = require('./client');
const { configPath } = require('./config');

const DISCOVER_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;  // 24h

function cachePath() {
  // Scope the cache by API base so switching between prod / staging / a custom
  // XLSX_FOR_AI_API doesn't reuse a catalog from a different host. Co-located
  // with config.json so XFA_CONFIG_DIR override flows through for tests.
  const baseHash = crypto.createHash('sha256').update(apiBase()).digest('hex').slice(0, 16);
  return path.join(path.dirname(configPath()), `tools-cache-${baseHash}.json`);
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
    const finalPath = cachePath();
    const dir = path.dirname(finalPath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = { fetched_at: Date.now(), tools };
    // Atomic write: temp file in the same dir + rename. Avoids torn writes
    // visible to a concurrent reader (e.g., two MCP server processes starting
    // at once on the same host).
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, finalPath);
  } catch (_) {
    // Cache write failures are non-fatal — the next startup just re-fetches.
  }
}

function isCacheFresh(entry) {
  if (!entry || typeof entry.fetched_at !== 'number') return false;
  const now = Date.now();
  // Future timestamps are never "fresh" — clock skew or tampering would
  // otherwise pin a cache forever (negative age < TTL is always true).
  if (entry.fetched_at > now) return false;
  return (now - entry.fetched_at) < CACHE_TTL_MS;
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
 * mergeTools: server catalog wins on name collision, but FIELD-BY-FIELD —
 * the remote response only overwrites fields it actually provides, with ONE
 * carve-out: inputSchema for a tool the baked set defines is baked-wins (see
 * the inline note below and XLS-973/XLS-873). The baked-in description survives
 * whatever the server omits.
 *
 * History: this used to rely on /api/v1/tools/list returning a minimal manifest
 * ({name, category, ...} with NO inputSchema), so a plain {...baked, ...remote}
 * left the baked inputSchema intact. Two separate hazards make that unsafe now:
 *   1. If the server omits inputSchema, Claude Desktop drops the whole array —
 *      the baked schema must fill it in. SPM P0 2026-06-05
 *      (mcp-toolslist-missing-inputschema).
 *   2. The server now DOES return a full inputSchema (the raw route contract,
 *      file_b64), and a plain spread let it overwrite the baked file_path
 *      contract the client actually implements → tool uncallable as advertised
 *      (XLS-973/XLS-873). The inputSchema carve-out below fixes (2) while still
 *      guaranteeing (1): a known tool always ends up with its baked schema.
 *
 * Order: remote tools first (preserving server order), then any baked-in
 * tool whose name isn't in the remote set. That way the server can still
 * remove a tool, and a tool the client knows how to dispatch survives a
 * server forgetting it.
 */
function mergeTools(remote, baked) {
  const bakedByName = new Map();
  for (const t of baked) {
    if (t && typeof t.name === 'string') bakedByName.set(t.name, t);
  }
  const out = [];
  const seen = new Set();
  for (const t of remote) {
    if (!t || typeof t.name !== 'string') continue;
    if (seen.has(t.name)) continue;  // dedupe within remote too — first wins
    const bakedTool = bakedByName.get(t.name);
    // {...baked, ...remote}: remote wins on every field it actually has;
    // baked fills in fields remote omits (description).
    //
    // EXCEPT inputSchema for a tool the baked client already implements. The
    // client's dispatchTool + validateToolArgs are bound to the BAKED input
    // contract — the xlsx_* workhorses take a `file_path` the client reads and
    // relays as `file_b64`; the base64 surface is OUTPUT-only. The hosted
    // /api/v1/tools/list now returns its OWN inputSchema (the raw route
    // contract, which requires `file_b64`), and the old spread let that
    // overwrite the baked schema. That published a shape the client cannot
    // satisfy: a schema-following caller sends `file_b64`, validateToolArgs
    // demands `file_path`, and the tool is uncallable as advertised — the
    // schema<->impl drift class (XLS-973 xlsx_eval, XLS-873 xlsx_write). So for
    // a tool the baked set defines a schema for, that baked inputSchema is
    // authoritative; remote-only tools (no baked entry) keep their own schema
    // and ride the generic relay. The stale comment above at line ~110 assumed
    // the server returned a minimal manifest with no inputSchema — it no longer
    // does, which is exactly what reintroduced the drift.
    let merged;
    if (bakedTool) {
      merged = { ...bakedTool, ...t };
      if (bakedTool.inputSchema) merged.inputSchema = bakedTool.inputSchema;
    } else {
      merged = t;
    }
    out.push(merged);
    seen.add(t.name);
  }
  for (const t of baked) {
    if (!t || typeof t.name !== 'string') continue;  // tolerate malformed baked entries
    if (seen.has(t.name)) continue;
    out.push(t);
    seen.add(t.name);
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
