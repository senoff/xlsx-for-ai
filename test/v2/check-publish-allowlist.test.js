'use strict';

/**
 * Tests for the prepublish allowlist guard.
 *
 * Verifies the guard:
 *   - passes when every runtime lib/ require is in the files allowlist
 *   - exits non-zero when a require is missing
 *   - normalizes the .js suffix (require('./lib/foo') matches files entry
 *     'lib/foo.js')
 *
 * Drives the guard via child_process so we exercise the actual exit codes
 * the npm hook will see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-publish-allowlist.js');

function runGuard(rootDir) {
  return spawnSync('node', [GUARD_SCRIPT], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

/**
 * Build a throwaway tarball-shaped tree: package.json + a single index.js
 * with one require, and the lib/ files specified. The guard resolves
 * ROOT via __dirname-of-the-script, so we DON'T copy guard there — we
 * point the guard at a fake ROOT via a custom version of the script that
 * uses an env var. Simpler approach: copy a temp package.json into the
 * repo's own scripts/ context by replacing the real package.json
 * temporarily. We avoid that with a synthetic minimal fixture instead.
 *
 * Strategy: write a copy of the guard into the temp dir adjacent to its
 * own scripts/, then run that copy. The guard's __dirname resolution
 * picks up the temp scripts/ as ROOT/scripts.
 */
function buildFixture({ files, indexBody = "require('./lib/foo');" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-allowlist-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', files }, null, 2),
  );
  fs.writeFileSync(path.join(tmp, 'index.js'), indexBody);
  fs.writeFileSync(path.join(tmp, 'mcp.js'), '// no requires here\n');
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'lib', 'foo.js'), '// foo body\n');

  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD_SCRIPT, path.join(tmp, 'scripts', 'check-publish-allowlist.js'));

  return tmp;
}

test('guard exits 0 when every lib require is in files', () => {
  const tmp = buildFixture({ files: ['index.js', 'mcp.js', 'lib/foo.js'] });
  const res = spawnSync('node', [path.join(tmp, 'scripts', 'check-publish-allowlist.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ok/);
});

test('guard exits 1 when a required lib file is missing from files', () => {
  const tmp = buildFixture({ files: ['index.js', 'mcp.js' /* no lib/foo.js */] });
  const res = spawnSync('node', [path.join(tmp, 'scripts', 'check-publish-allowlist.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /REFUSING TO PUBLISH/);
  assert.match(res.stderr, /lib\/foo\.js/);
});

test('guard normalizes .js suffix — require without .js matches files entry with .js', () => {
  const tmp = buildFixture({
    files: ['index.js', 'mcp.js', 'lib/foo.js'],
    // require('./lib/foo') — no .js — must still pass
    indexBody: "const x = require('./lib/foo');\n",
  });
  const res = spawnSync('node', [path.join(tmp, 'scripts', 'check-publish-allowlist.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('guard exits 2 when package.json files is not an array', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-allowlist-bad-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', files: 'not-an-array' }, null, 2),
  );
  fs.writeFileSync(path.join(tmp, 'index.js'), '');
  fs.writeFileSync(path.join(tmp, 'mcp.js'), '');
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD_SCRIPT, path.join(tmp, 'scripts', 'check-publish-allowlist.js'));
  const res = spawnSync('node', [path.join(tmp, 'scripts', 'check-publish-allowlist.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /must be an array/);
});

test('guard against the live package.json — current main passes', () => {
  const res = runGuard(REPO_ROOT);
  assert.equal(res.status, 0, res.stderr);
});

test('guard walks transitive lib-to-lib requires (the grace HIGH catch)', () => {
  // Fixture: index.js requires lib/foo.js which requires lib/bar.js.
  // bar.js is NOT in the files allowlist — the guard must walk into
  // foo.js to discover the missing transitive.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-allowlist-trans-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '0.0.0',
      files: ['index.js', 'mcp.js', 'lib/foo.js' /* lib/bar.js MISSING */],
    }, null, 2),
  );
  fs.writeFileSync(path.join(tmp, 'index.js'), "require('./lib/foo');\n");
  fs.writeFileSync(path.join(tmp, 'mcp.js'), '// no requires\n');
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'lib', 'foo.js'), "require('./bar');\n");
  fs.writeFileSync(path.join(tmp, 'lib', 'bar.js'), '// leaf\n');
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD_SCRIPT, path.join(tmp, 'scripts', 'check-publish-allowlist.js'));

  const res = spawnSync('node', [path.join(tmp, 'scripts', 'check-publish-allowlist.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /lib\/bar\.js/);
});
