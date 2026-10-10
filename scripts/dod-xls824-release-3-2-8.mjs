#!/usr/bin/env node
/**
 * XLS-824 DoD — npm 3.2.8 Release (batch-publish XLS-763 / XLS-808 / XLS-815).
 *
 * This is a RELEASE-INTEGRITY check, not a re-test of the three batched cards (each carries its
 * own DoD). It proves, at land time and network-free, that the release is COHERENT: the version
 * is bumped in both manifests AND the three batched features are actually present in the tree that
 * publish.yml will pack. A green here means "publishing this main ships 3.2.8 WITH the batch",
 * which is exactly what the door must know before it lets the Release PR land.
 *
 * Arms (one per release-integrity clause; each reddens on the pre-release state):
 *   ARM1  package.json version === 3.2.8
 *   ARM2  package-lock.json version === 3.2.8 in BOTH the top field and packages[""] (the lockfile
 *         publish resolves against — a half-bumped lock ships a mismatched tree)
 *   ARM3  XLS-815 ships: lib/read-file.js exists on disk AND is in package.json "files" (else the
 *         hardened reader is MODULE_NOT_FOUND in the published tarball)
 *   ARM4  XLS-763 ships: README.md references BOTH discovery routes (/api/v1/reference AND
 *         /api/v1/openapi.json) — naming only one is a half-door
 *   ARM5  XLS-808 present: .github/audit-allowlist.json carries all 3 unreachable-HIGH GHSAs
 *
 * `--selftest` POSITIVE CONTROL: re-checks ARM1/ARM3/ARM4/ARM5 against a mutated fixture and
 * asserts each reddens, so a future edit that defangs an arm fails loudly.
 *
 * EXIT: 0 = all arms pass; 1 = a named release-integrity clause failed (fails closed);
 *       6 = INDETERMINATE (a subject file is absent — e.g. run on a cold tree before the Release
 *           PR lands; register-before-land cold pole, never a false green).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECT = "3.2.8";
const REQUIRED_GHSAS = ["GHSA-7p8r-x3mc-p8w7", "GHSA-v2v4-37r5-5v8g", "GHSA-mwp4-54f8-5fhr"];

function readJSON(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return { __absent: true, __path: rel };
  return JSON.parse(readFileSync(p, "utf8"));
}
function readText(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// Returns {ok:true} | {ok:false, why} | {indeterminate:true, why}
function arm1(pj) {
  if (pj.__absent) return { indeterminate: true, why: `${pj.__path} absent` };
  return pj.version === EXPECT
    ? { ok: true }
    : { ok: false, why: `package.json version is ${pj.version}, expected ${EXPECT}` };
}
function arm2(pl) {
  if (pl.__absent) return { indeterminate: true, why: `${pl.__path} absent` };
  const top = pl.version;
  const self = pl.packages && pl.packages[""] ? pl.packages[""].version : undefined;
  if (top !== EXPECT) return { ok: false, why: `package-lock top version is ${top}, expected ${EXPECT}` };
  if (self !== EXPECT) return { ok: false, why: `package-lock packages[""].version is ${self}, expected ${EXPECT}` };
  return { ok: true };
}
function arm3(pj) {
  if (pj.__absent) return { indeterminate: true, why: `package.json absent` };
  const onDisk = existsSync(join(ROOT, "lib/read-file.js"));
  const files = Array.isArray(pj.files) ? pj.files : [];
  const shipped = files.some((f) => f === "lib/read-file.js" || f === "lib" || f === "lib/");
  if (!onDisk) return { ok: false, why: "lib/read-file.js (XLS-815 hardened reader) missing on disk" };
  if (!shipped) return { ok: false, why: "lib/read-file.js not in package.json files -> MODULE_NOT_FOUND in tarball" };
  return { ok: true };
}
function arm4(readme) {
  if (readme === null) return { indeterminate: true, why: "README.md absent" };
  const hasRef = readme.includes("/api/v1/reference");
  const hasOpenapi = readme.includes("/api/v1/openapi.json");
  if (hasRef && hasOpenapi) return { ok: true };
  return { ok: false, why: `README missing discovery route(s): reference=${hasRef} openapi=${hasOpenapi}` };
}
function arm5(allowlist) {
  if (allowlist.__absent) return { indeterminate: true, why: `${allowlist.__path} absent` };
  const raw = JSON.stringify(allowlist);
  const missing = REQUIRED_GHSAS.filter((g) => !raw.includes(g));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, why: `audit-allowlist missing GHSA(s): ${missing.join(", ")}` };
}

function runArms() {
  const pj = readJSON("package.json");
  const pl = readJSON("package-lock.json");
  const readme = readText("README.md");
  const allow = readJSON(".github/audit-allowlist.json");
  return [
    ["ARM1 version=3.2.8 (package.json)", arm1(pj)],
    ["ARM2 version=3.2.8 (package-lock, both fields)", arm2(pl)],
    ["ARM3 XLS-815 lib/read-file.js ships", arm3(pj)],
    ["ARM4 XLS-763 README names both API routes", arm4(readme)],
    ["ARM5 XLS-808 audit-allowlist carries 3 GHSAs", arm5(allow)],
  ];
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const results = runArms();
  let indeterminate = null, failed = null;
  for (const [name, r] of results) {
    if (r.ok) { console.log(`  ok    ${name}`); continue; }
    if (r.indeterminate) { console.log(`  INDET ${name} -- ${r.why}`); indeterminate ??= `${name}: ${r.why}`; continue; }
    console.log(`  FAIL  ${name} -- ${r.why}`); failed ??= `${name}: ${r.why}`;
  }
  if (failed) { console.log(`\nXLS-824 FAIL (rc=1): ${failed}`); process.exit(1); }
  if (indeterminate) { console.log(`\nXLS-824 INDETERMINATE (rc=6): ${indeterminate}`); process.exit(6); }
  console.log("\nXLS-824 OK (rc=0): 3.2.8 bumped in both manifests; XLS-763/808/815 all present in the shipping tree.");
  process.exit(0);
}

// POSITIVE CONTROL — mutate each subject and assert the arm reddens.
function selftest() {
  const fails = [];
  const chk = (label, r) => { if (!(r && r.ok === false)) fails.push(label); };
  chk("ARM1 must red on wrong version", arm1({ version: "3.2.7" }));
  chk("ARM2 must red on half-bumped lock", arm2({ version: "3.2.8", packages: { "": { version: "3.2.7" } } }));
  chk("ARM3 must red when reader not in files", arm3({ files: ["index.js"], version: EXPECT }));
  chk("ARM4 must red on half-door README", arm4("see /api/v1/reference only"));
  chk("ARM5 must red on dropped GHSA", arm5({ entries: [{ ghsa: REQUIRED_GHSAS[0] }] }));
  if (fails.length) { console.log("SELFTEST FAILED — an arm did not redden:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("SELFTEST OK: every arm reddens on its mutated fixture.");
  process.exit(0);
}

main();
