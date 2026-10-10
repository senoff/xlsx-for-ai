#!/usr/bin/env node
/**
 * XLS-504 DoD — MCP Registry drift check (two surfaces: npm `latest` vs registry `isLatest`).
 *
 * WHAT DRIFT IS. Two doors hand an agent a version of this server. npm's `latest` dist-tag is
 * one; the MCP Registry's `isLatest` record is the other. They are supposed to name the SAME
 * version. When the publish pipeline strands the registry sync behind npm (the failure XLS-504
 * root-fixes), the registry keeps pointing at an older tarball while npm has moved on — an agent
 * installing from the registry door gets stale bytes. This check MEASURES that gap.
 *
 * THE TWO SURFACES (each resolved by the field the door actually asserts with, never position):
 *   • npm      — `npm view xlsx-for-ai dist-tags --json` -> `.latest`
 *   • registry — GET {registry}/v0/servers?search=<mcp_name>&version=latest, take the ONE record
 *                whose _meta.io.modelcontextprotocol.registry/official.isLatest === true, then its
 *                packages[] entry for identifier "xlsx-for-ai" -> `.version`.
 *                *** KEY ON isLatest. NEVER ON LIST POSITION. *** The search returns every version
 *                UNORDERED (measured 2026-07-15: 9 records, the FIRST was 2.0.0 while isLatest was
 *                the LAST). "Read the first result" yields a wrong answer that LOOKS right.
 *
 * THREE VERDICTS (the card's exit contract — NOT the usual 0/1/6):
 *   0  AGREE        — npm latest === registry isLatest version. No drift.
 *   2  DRIFT        — both surfaces measured, versions differ. Fails closed (this is a real defect).
 *   7  INDETERMINATE— a surface could not be measured (npm/registry unreachable, ambiguous
 *                     isLatest, wrong-name match). UNREACHABLE IS NOT "no drift"; we measured nothing.
 *
 * The POSITIVE-CONTROL modes (`--witness`, `--selftest`) are NOT drift measurements and carry a
 * DIFFERENT, deliberate contract — the repo's pass/fail/cold-pole convention (matches
 * dod-xls824): 0 = control passed, 1 = control FAILED (the check is defanged — a real defect),
 * 6 = INDETERMINATE (subject absent on a cold tree). Live 0/2/7 answers "is there drift?";
 * control 0/1/6 answers "does the check still work?" — two questions, two contracts, on purpose.
 *
 * ── RED ARM, witnessable on immutable committed bytes (`--witness`) ───────────────────────────
 * A drift check that can only ever go green is worthless — you cannot tell it apart from a check
 * that does nothing. The positive control: replay the committed 2026-07-15 registry response
 * (scripts/fixtures/mcp-registry-xlsx-for-ai-2026-07-15.json — isLatest -> 3.2.3) against npm's
 * dist-tag as it stood that day (3.2.4), through the SAME compare() the live path uses. It MUST
 * report DRIFT (exit 2). If it does not, the check has been defanged and `--witness` fails loud
 * (exit 1). This arm needs no network and reproduces from bytes in the tree forever.
 *
 * ── `--selftest` — compare() mutation controls (positive control on the core predicate) ──────
 *
 * READ-ONLY: queries npm + the public registry, reads a committed fixture. Mutates nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "xlsx-for-ai";
const MCP_NAME = "io.github.senoff/xlsx-for-ai";
const REGISTRY = process.env.MCP_REGISTRY || "https://registry.modelcontextprotocol.io";
const OFFICIAL = "io.modelcontextprotocol.registry/official";
const FIXTURE_2026_07_15 = "scripts/fixtures/mcp-registry-xlsx-for-ai-2026-07-15.json";
const NPM_LATEST_2026_07_15 = "3.2.4"; // npm dist-tags.latest as it stood on 2026-07-15 (registry then lagged at 3.2.3)

// ── surface resolvers. Each returns {version} | {indeterminate, why}; never invents a version. ──

function resolveNpm() {
  let raw;
  try {
    raw = execFileSync("npm", ["view", PKG, "dist-tags", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { indeterminate: true, why: `npm view ${PKG} dist-tags failed: ${String(e.message || e).slice(0, 140)}` };
  }
  let tags;
  try {
    tags = JSON.parse(raw);
  } catch (e) {
    return { indeterminate: true, why: `npm dist-tags is not parseable JSON: ${String(e).slice(0, 100)}` };
  }
  const v = tags && tags.latest;
  if (typeof v !== "string" || !v) return { indeterminate: true, why: `npm dist-tags has no string 'latest' (got ${JSON.stringify(v)})` };
  return { version: v };
}

/** Extract the registry's isLatest npm version from an ALREADY-PARSED search response.
 *  Shared by the live path and the witness fixture so both key on isLatest identically. */
function registryVersionFromResponse(doc) {
  const servers = Array.isArray(doc) ? doc : doc && doc.servers;
  if (!Array.isArray(servers) || servers.length === 0)
    return { indeterminate: true, why: `registry returned zero records for ${MCP_NAME} — a search that did not answer, not proof of absence` };
  // The search is FUZZY; match the name EXACTLY or we would report on a stranger's server.
  const mine = servers.filter((x) => x && x.server && x.server.name === MCP_NAME);
  if (mine.length === 0)
    return { indeterminate: true, why: `registry returned ${servers.length} record(s) but none named exactly ${MCP_NAME}` };
  const latest = mine.filter((x) => ((x._meta || {})[OFFICIAL] || {}).isLatest === true);
  if (latest.length !== 1)
    return { indeterminate: true, why: `registry has ${latest.length} isLatest record(s) for ${MCP_NAME} (expected exactly 1 of ${mine.length}) — cannot tell which an agent installs` };
  const rec = latest[0].server;
  const pkgs = (rec.packages || []).filter((p) => p.registryType === "npm" && p.identifier === PKG);
  if (pkgs.length !== 1)
    return { indeterminate: true, why: `isLatest record names ${pkgs.length} npm package(s) matching ${PKG} (expected exactly 1)` };
  const v = pkgs[0].version;
  if (typeof v !== "string" || !v) return { indeterminate: true, why: `isLatest npm package has no string version (got ${JSON.stringify(v)})` };
  return { version: v };
}

async function resolveRegistryLive() {
  const url = `${REGISTRY}/v0/servers?search=${encodeURIComponent(MCP_NAME)}&version=latest`;
  let doc;
  const ATTEMPTS = 3;
  const BACKOFF = [1000, 2000];
  // A transient 5xx or a 429 rate-limit is the registry momentarily refusing to answer, not a
  // verdict — retry it like a network error. A non-retryable 4xx (e.g. 404 for a name we don't
  // own) IS the registry's answer, so return INDETERMINATE immediately without burning retries.
  const retryableStatus = (s) => s === 429 || (s >= 500 && s <= 599);
  for (let i = 0; i < ATTEMPTS; i++) {
    const lastAttempt = i === ATTEMPTS - 1;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30_000);
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": "xls504-drift-check" }, signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        if (retryableStatus(res.status) && !lastAttempt) { await new Promise((r) => setTimeout(r, BACKOFF[i])); continue; }
        return { indeterminate: true, why: `registry returned HTTP ${res.status} — it did not answer, so nothing is measured` };
      }
      doc = await res.json();
      break;
    } catch (e) {
      if (lastAttempt) return { indeterminate: true, why: `registry unreachable: ${String(e.message || e).slice(0, 120)} — unreachable is not a verdict` };
      await new Promise((r) => setTimeout(r, BACKOFF[i]));
    }
  }
  return registryVersionFromResponse(doc);
}

// ── the predicate under test ──────────────────────────────────────────────────────────────────
// Returns {verdict:'agree'|'drift'|'indeterminate', npm, registry, why?}
function compare(npmRes, regRes) {
  if (npmRes.indeterminate) return { verdict: "indeterminate", why: `npm surface: ${npmRes.why}` };
  if (regRes.indeterminate) return { verdict: "indeterminate", why: `registry surface: ${regRes.why}` };
  if (npmRes.version === regRes.version)
    return { verdict: "agree", npm: npmRes.version, registry: regRes.version };
  return { verdict: "drift", npm: npmRes.version, registry: regRes.version };
}

const EXIT = { agree: 0, drift: 2, indeterminate: 7 };

function report(c) {
  console.log(`  DRIFT-CHECK marker: two-surface npm-vs-registry-isLatest`); // grep anchor for register-before-land
  console.log(`  npm      dist-tags.latest = ${c.npm ?? "(unmeasured)"}`);
  console.log(`  registry isLatest         = ${c.registry ?? "(unmeasured)"}  [keyed on isLatest, not list position]`);
  if (c.verdict === "agree") console.log(`\nXLS-504 AGREE (rc=0): both doors hand agents ${c.npm}. No drift.`);
  else if (c.verdict === "drift") console.log(`\nXLS-504 DRIFT (rc=2): npm=${c.npm} but registry isLatest=${c.registry} — agents installing from the registry get stale bytes.`);
  else console.log(`\nXLS-504 INDETERMINATE (rc=7): ${c.why}`);
}

async function live() {
  const [npmRes, regRes] = [resolveNpm(), await resolveRegistryLive()];
  const c = compare(npmRes, regRes);
  report(c);
  process.exit(EXIT[c.verdict]);
}

// RED ARM — committed immutable bytes prove the check DETECTS drift, network-free.
function witness() {
  const p = join(ROOT, FIXTURE_2026_07_15);
  if (!existsSync(p)) {
    console.log(`XLS-504 WITNESS INDETERMINATE (rc=6): ${FIXTURE_2026_07_15} absent — RED arm cannot be witnessed on a cold tree.`);
    process.exit(6);
  }
  const doc = JSON.parse(readFileSync(p, "utf8"));
  const regRes = registryVersionFromResponse(doc);
  const npmRes = { version: NPM_LATEST_2026_07_15 };
  const c = compare(npmRes, regRes);
  console.log(`  [witness] replaying registry @ 2026-07-15 vs npm latest @ 2026-07-15 (${NPM_LATEST_2026_07_15})`);
  report(c);
  if (c.verdict === "drift" && c.npm === "3.2.4" && c.registry === "3.2.3") {
    console.log("WITNESS OK: the RED arm reddens on immutable committed bytes (npm 3.2.4 vs registry 3.2.3 -> DRIFT).");
    process.exit(0);
  }
  console.log(`WITNESS FAILED (rc=1): expected DRIFT npm=3.2.4/registry=3.2.3, got verdict=${c.verdict} npm=${c.npm} registry=${c.registry}. The drift check has been defanged.`);
  process.exit(1);
}

// compare() mutation controls — the core predicate must classify each shape correctly.
function selftest() {
  const fails = [];
  const expect = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${got}, want ${want}`); };
  expect("equal -> agree", compare({ version: "3.2.9" }, { version: "3.2.9" }).verdict, "agree");
  expect("differ -> drift", compare({ version: "3.2.9" }, { version: "3.2.8" }).verdict, "drift");
  expect("npm unmeasured -> indeterminate", compare({ indeterminate: true, why: "x" }, { version: "3.2.9" }).verdict, "indeterminate");
  expect("registry unmeasured -> indeterminate", compare({ version: "3.2.9" }, { indeterminate: true, why: "x" }).verdict, "indeterminate");
  // isLatest resolver must reject the position trap: first record 2.0.0, isLatest the last.
  const posTrap = { servers: [
    { server: { name: MCP_NAME, version: "2.0.0", packages: [{ registryType: "npm", identifier: PKG, version: "2.0.0" }] }, _meta: { [OFFICIAL]: { isLatest: false } } },
    { server: { name: MCP_NAME, version: "3.2.3", packages: [{ registryType: "npm", identifier: PKG, version: "3.2.3" }] }, _meta: { [OFFICIAL]: { isLatest: true } } },
  ] };
  expect("resolver keys on isLatest not position", registryVersionFromResponse(posTrap).version, "3.2.3");
  // ambiguous isLatest -> indeterminate, never a guess
  const twoLatest = { servers: [
    { server: { name: MCP_NAME, version: "3.2.3", packages: [{ registryType: "npm", identifier: PKG, version: "3.2.3" }] }, _meta: { [OFFICIAL]: { isLatest: true } } },
    { server: { name: MCP_NAME, version: "3.2.4", packages: [{ registryType: "npm", identifier: PKG, version: "3.2.4" }] }, _meta: { [OFFICIAL]: { isLatest: true } } },
  ] };
  if (!registryVersionFromResponse(twoLatest).indeterminate) fails.push("two isLatest records must be indeterminate");
  if (fails.length) { console.log("SELFTEST FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("SELFTEST OK: compare() and the isLatest resolver classify agree/drift/indeterminate/position-trap correctly.");
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes("--witness")) witness();
else if (argv.includes("--selftest")) selftest();
else live();
