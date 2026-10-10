#!/usr/bin/env node
'use strict';

/**
 * scripts/gen-tool-floor.js — GENERATE the baked tool floor from live inventory.
 *
 * The problem this kills (XLS-849): the client bakes a static tool floor (mcp.js
 * TOOLS + lib/annotations.js TOOL_ANNOTATIONS) used when the server is
 * unreachable AND there is no fresh cache — the cold-start path. That floor was
 * hand-frozen at 50 tools while the server grew to 65 (the 13 tier-2-funnel
 * import/feed producers + xlsx_pii_scan + xlsx_vault_scan). A cold-start agent
 * therefore never saw the missing tools. Worse: `mergeTools` fills a tool's
 * description from the baked floor even ONLINE (the /api/v1/tools/list wire shape
 * carries no `description`), so a tool absent from the floor reaches the agent
 * with no description at all — which Claude Desktop silently drops.
 *
 * The fix is a GENERATED floor + a DRIFT GUARD, mirroring the server-side
 * contract:check doctrine (XLS-761): the floor is emitted from the live endpoint
 * and a `--check` run fails closed when the baked names no longer match live
 * inventory — turning silent floor-rot into a red CI signal.
 *
 * Source of truth: GET ${apiBase}/api/v1/tools/list (full defs: name, inputSchema,
 * annotations{title, readOnlyHint, destructiveHint, ...}). The hand-authored 50
 * are left untouched (their rich, length-capped descriptions are curated); only
 * tools MISSING from the hand-authored base are generated, with description taken
 * from the endpoint's annotations.title (the only description-ish field the wire
 * carries) and annotations narrowed to the client map's {title, readOnlyHint,
 * destructiveHint} shape.
 *
 * Usage:
 *   node scripts/gen-tool-floor.js            # (re)write generated/tool-floor.generated.js
 *   node scripts/gen-tool-floor.js --check    # fail closed (exit 1) if baked names != live inventory
 *
 * Exit: 0 ok/no-drift · 1 drift (check mode) · 2 could not reach inventory.
 */

const fs   = require('fs');
const path = require('path');

const ROOT           = path.join(__dirname, '..');
const GENERATED_PATH = path.join(ROOT, 'generated', 'tool-floor.generated.js');

// apiBase honours XLSX_FOR_AI_API so a generate/check can target staging or a PR
// deploy; defaults to prod. Imported lazily so --help-style runs never boot config.
function inventoryUrl() {
  const { apiBase } = require('../lib/client');
  return apiBase().replace(/\/+$/, '') + '/api/v1/tools/list';
}

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS   = 3;
const FETCH_BACKOFF_MS = [500, 1500]; // between attempts 1→2, 2→3

/**
 * Could-not-reach-inventory. This is the ONLY error class the top-level maps to
 * exit 2 (warn-and-proceed in CI). Every OTHER error — a code bug, a parse
 * failure, a 4xx, a malformed body — is a REAL failure that must block, never
 * masquerade as "infra". A green check has to mean "verified against live
 * inventory", so the not-verified reasons are split: transient/unreachable (2)
 * vs. broken (non-0/non-2 → the publish gate blocks).
 */
class NetworkError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url) {
  // No global fetch (Node <18, or a stripped runtime) is an environment problem,
  // not a reachability one — but from the gate's view it is "could not verify",
  // so it rides the NetworkError→exit-2 path rather than silently passing. The
  // engines pin (package.json) + setup-node in CI are what actually prevent it.
  if (typeof fetch !== 'function') {
    throw new NetworkError('global fetch is unavailable — Node >=18 is required to verify the tool floor');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (e) {
    // Network down, DNS, timeout/abort — transient/reachability. Retryable.
    throw new NetworkError(`GET ${url} failed: ${e && e.message ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
  // 5xx = server-side/transient → retry as unreachable. 4xx = the endpoint
  // answered and rejected us (auth, bad path) → a REAL problem, do not retry,
  // do not downgrade to a warning.
  if (res.status >= 500) throw new NetworkError(`GET ${url} -> HTTP ${res.status}`);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} (endpoint reachable but rejected the request)`);
  const body = await res.json();
  // A 200 with the wrong shape is the endpoint misbehaving, not unreachable —
  // block rather than warn, so a broken contract can't slip a stale floor through.
  if (!body || !Array.isArray(body.tools)) throw new Error(`GET ${url} -> 200 but response has no tools array`);
  return body.tools;
}

async function fetchInventory() {
  const url = inventoryUrl();
  let lastNetErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e; // real error — fail immediately, no retry
      lastNetErr = e;
      if (attempt < FETCH_ATTEMPTS) await sleep(FETCH_BACKOFF_MS[attempt - 1]);
    }
  }
  throw lastNetErr; // exhausted retries on transient/unreachable — stays a NetworkError → exit 2
}

/** Names in the hand-authored base = current baked TOOLS minus whatever the generated file currently contributes. */
function handAuthoredNames() {
  const { TOOLS } = require('../mcp.js');
  let generatedNames = new Set();
  try {
    const { GENERATED_FLOOR_TOOLS } = require('../generated/tool-floor.generated.js');
    generatedNames = new Set((GENERATED_FLOOR_TOOLS || []).map((t) => t.name));
  } catch (_) {
    /* first run — no generated file yet; every baked tool is hand-authored */
  }
  return new Set(TOOLS.map((t) => t.name).filter((n) => !generatedNames.has(n)));
}

/** All baked names (hand-authored + generated) as the client would expose them cold. */
function bakedNames() {
  const { TOOLS } = require('../mcp.js');
  return new Set(TOOLS.map((t) => t.name));
}

/** Narrow a live entry to the client floor shape. description := annotations.title (only wire description). */
function toFloorTool(inv) {
  const ann = (inv.annotations && typeof inv.annotations === 'object') ? inv.annotations : {};
  const title = typeof ann.title === 'string' && ann.title ? ann.title : inv.name;
  return { name: inv.name, description: title, inputSchema: inv.inputSchema };
}

function toFloorAnnotation(inv) {
  const ann = (inv.annotations && typeof inv.annotations === 'object') ? inv.annotations : {};
  return {
    title: typeof ann.title === 'string' && ann.title ? ann.title : inv.name,
    readOnlyHint: typeof ann.readOnlyHint === 'boolean' ? ann.readOnlyHint : false,
    destructiveHint: typeof ann.destructiveHint === 'boolean' ? ann.destructiveHint : false,
  };
}

function render(missing) {
  const tools = missing.map(toFloorTool);
  const annotations = {};
  for (const inv of missing) annotations[inv.name] = toFloorAnnotation(inv);
  const banner =
    '// GENERATED by scripts/gen-tool-floor.js — DO NOT EDIT BY HAND.\n' +
    '// The baked tool floor for tools not hand-authored in mcp.js, emitted from the\n' +
    '// live GET /api/v1/tools/list inventory so a cold-start client (no network, no\n' +
    '// cache) still exposes the full server tool set. Regenerate: node scripts/gen-tool-floor.js\n' +
    '// Drift-guarded: node scripts/gen-tool-floor.js --check (XLS-849).\n';
  return (
    banner +
    "'use strict';\n\n" +
    'const GENERATED_FLOOR_TOOLS = ' + JSON.stringify(tools, null, 2) + ';\n\n' +
    'const GENERATED_FLOOR_ANNOTATIONS = ' + JSON.stringify(annotations, null, 2) + ';\n\n' +
    'module.exports = { GENERATED_FLOOR_TOOLS, GENERATED_FLOOR_ANNOTATIONS };\n'
  );
}

async function generate() {
  const inv = await fetchInventory();
  const base = handAuthoredNames();
  const missing = inv
    .filter((t) => t && typeof t.name === 'string' && !base.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(path.dirname(GENERATED_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_PATH, render(missing), 'utf8');
  console.log(
    `wrote ${path.relative(ROOT, GENERATED_PATH)} — ${missing.length} generated floor tool(s): ` +
      missing.map((t) => t.name).join(', '),
  );
  return 0;
}

/**
 * The pure drift predicate — the heart of `--check`, factored out so the mutation
 * proof (test/v2/tool-floor.test.js) can exercise the REAL diff logic with no
 * network (XLS-979). Both args are name iterables; returns the two directed
 * differences plus a boolean.
 *   missingFromFloor: live tool(s) the baked floor lacks — a tool was added to
 *     inventory without a floor regen. THIS is the failure the standing check
 *     must RED on (a cold-start agent would never see the tool).
 *   staleInFloor: baked tool(s) live inventory dropped — the floor names a tool
 *     the server no longer serves.
 */
function diffFloor(liveNames, bakedNames) {
  const live = liveNames instanceof Set ? liveNames : new Set(liveNames);
  const baked = bakedNames instanceof Set ? bakedNames : new Set(bakedNames);
  const missingFromFloor = [...live].filter((n) => !baked.has(n)).sort();
  const staleInFloor = [...baked].filter((n) => !live.has(n)).sort();
  return { missingFromFloor, staleInFloor, drift: missingFromFloor.length > 0 || staleInFloor.length > 0 };
}

async function check() {
  const inv = await fetchInventory();
  const live = new Set(inv.map((t) => t.name));
  // Re-require fresh so a just-written generated file is reflected.
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.sep + 'mcp.js') || k.includes(path.join('generated', 'tool-floor.generated.js'))) {
      delete require.cache[k];
    }
  }
  const baked = bakedNames();
  const { missingFromFloor, staleInFloor, drift } = diffFloor(live, baked);
  if (!drift) {
    console.log(`floor == inventory (${baked.size} tools) — no drift.`);
    return 0;
  }
  if (missingFromFloor.length) {
    console.error(`DRIFT: ${missingFromFloor.length} live tool(s) absent from the baked floor: ${missingFromFloor.join(', ')}`);
  }
  if (staleInFloor.length) {
    console.error(`DRIFT: ${staleInFloor.length} baked tool(s) no longer in live inventory: ${staleInFloor.join(', ')}`);
  }
  console.error('Regenerate the floor: node scripts/gen-tool-floor.js');
  return 1;
}

async function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'generate';
  try {
    return mode === 'check' ? await check() : await generate();
  } catch (err) {
    if (err instanceof NetworkError) {
      // Could not reach inventory. Exit 2 (infra), NOT 0 — a green check must mean
      // "verified against live inventory", never "skipped" — and NOT 1/3 either,
      // so the publish gate warns-and-proceeds instead of blocking on prod being down.
      console.error(`could not reach live inventory: ${err.message}`);
      return 2;
    }
    // Any OTHER error is a REAL failure (bug, parse error, 4xx, bad shape). Do not
    // disguise it as "infra" — exit 3 so the publish gate BLOCKS.
    console.error(err && err.stack ? err.stack : String(err));
    return 3;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { toFloorTool, toFloorAnnotation, handAuthoredNames, bakedNames, diffFloor };
