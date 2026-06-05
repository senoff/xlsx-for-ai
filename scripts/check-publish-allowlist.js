#!/usr/bin/env node
'use strict';

/**
 * Prepublish guard — every `require('./lib/X')` in the binary entry points
 * (mcp.js + index.js) MUST appear in `package.json` -> `files` allowlist.
 *
 * Bug class this kills: a new runtime-required source file gets added to
 * lib/ but is silently excluded from the published tarball because the
 * `files` allowlist (explicit by design — see strip-pattern doctrine)
 * isn't updated. The published package then crashes on startup with
 * MODULE_NOT_FOUND on first require. Exact bug that shipped 2.25.0 -
 * 2.26.0 with `lib/annotations.js` missing.
 *
 * Exit codes:
 *   0  every runtime-required ./lib/ file is in the files allowlist
 *   1  one or more required files are missing — refuse to publish
 *   2  scanned file unreadable / package.json malformed
 *
 * Invoked from package.json scripts as `prepublishOnly`. Fast: pure
 * file-content scan, no network or subprocess.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Each entry point Node will load in the published package (from `bin` in
// package.json — kept in sync here). New entry points add a line here AND
// in package.json's `bin` block.
const ENTRY_POINTS = ['index.js', 'mcp.js'];

// Match any relative `require('./<name>')` or `require("./<name>")`. We
// resolve the captured spec against the requiring file's directory
// below so that `require('./bar')` inside `lib/foo.js` correctly
// resolves to `lib/bar.js`. The path may or may not include a `.js`
// suffix; we normalize at resolve-time.
const REQUIRE_RE = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;

function loadPkgFiles() {
  const pkgPath = path.join(ROOT, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`check-publish-allowlist: cannot read ${pkgPath}: ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(pkg.files)) {
    console.error('check-publish-allowlist: package.json `files` must be an array (explicit allowlist).');
    process.exit(2);
  }
  return new Set(pkg.files);
}

/**
 * Walk required lib/ files transitively. A lib/ file required ONLY from
 * another lib/ file (not from a top-level entry point) still must be in
 * the allowlist — otherwise its parent loads but crashes on first
 * require of the missing transitive. Real example: discover.js requires
 * client.js requires config.js — losing config.js from the allowlist
 * would crash on the first call to discover.
 *
 * Each entry in the queue is a ROOT-relative posix path (e.g. 'mcp.js',
 * 'lib/foo.js'). When we scan a file, we resolve its `require('./...')`
 * relative to that file's directory, then normalize back to a
 * ROOT-relative posix path so it matches against `package.json`'s
 * `files` allowlist (which uses ROOT-relative posix paths).
 */
function collectRequiredLibFiles() {
  const required = new Set();
  const queue = [...ENTRY_POINTS];
  const seen = new Set();

  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);

    // Resolve next to a path under ROOT. ENTRY_POINTS + lib/ paths are
    // ROOT-relative posix strings.
    const filePath = path.join(ROOT, next);
    let src;
    try {
      src = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`check-publish-allowlist: cannot read ${filePath}: ${err.message}`);
      process.exit(2);
    }
    const fromDir = path.posix.dirname(next.split(path.sep).join('/'));
    // Reset the regex's lastIndex — sharing a /g RegExp across multiple
    // exec loops without reset would skip matches in the second file.
    REQUIRE_RE.lastIndex = 0;
    let match;
    while ((match = REQUIRE_RE.exec(src))) {
      // match[1] is the captured spec, like './lib/foo' or './bar'.
      // Resolve against fromDir (also ROOT-relative posix) then normalize.
      const spec = match[1];
      const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
      let p = resolved;
      if (!p.endsWith('.js') && !p.endsWith('.json')) p += '.js';
      // Only track lib/ paths — top-level requires (../package.json, etc.)
      // don't need allowlist entries because the entry points themselves
      // are listed.
      if (!p.startsWith('lib/')) continue;
      required.add(p);
      if (!seen.has(p)) queue.push(p);
    }
  }
  return required;
}

const filesAllowlist = loadPkgFiles();
const required = collectRequiredLibFiles();

const missing = [...required].filter((p) => !filesAllowlist.has(p));

if (missing.length > 0) {
  console.error(
    'check-publish-allowlist: REFUSING TO PUBLISH — package.json `files` is missing required modules:\n' +
      missing.map((p) => `  - ${p}`).join('\n') +
      '\n' +
      'Either add the file(s) to the `files` array in package.json, or remove the\n' +
      "`require('./" + 'lib/...' + "')` call(s) that reference them. Refusing to publish a\n" +
      'tarball whose entry points crash on startup with MODULE_NOT_FOUND.',
  );
  process.exit(1);
}

console.log(
  `check-publish-allowlist: ok — all ${required.size} runtime lib/ require(s) are in the files allowlist.`,
);
