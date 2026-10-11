'use strict';

/**
 * XLS-2993: the logic of scripts/front-door-check.js that needs no network and no install.
 * The script itself is run for real by .github/workflows/front-door-check.yml.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const check = require('../../scripts/front-door-check');

const ROOT = path.join(__dirname, '..', '..');

test('PK-3: versions compare as numbers, not text', () => {
  assert.equal(check.compareVersions('4.2.4', '4.2.4'), 0);
  assert.equal(check.compareVersions('4.10.0', '4.9.9'), 1);
  assert.equal(check.compareVersions('4.2.3', '4.2.4'), -1);
  assert.throws(() => check.compareVersions('4.2', '4.2.4'));
  assert.throws(() => check.compareVersions('4.2.4-beta', '4.2.4'));
});

test('PK-3: before a release the package may be the latest or newer; after a release it must be the latest', () => {
  assert.equal(check.judgeVersion('4.2.4', '4.2.4', 'pre').status, 'PASS');
  assert.equal(check.judgeVersion('4.2.5', '4.2.4', 'pre').status, 'PASS');
  assert.equal(check.judgeVersion('4.2.3', '4.2.4', 'pre').status, 'FAIL');
  assert.equal(check.judgeVersion('4.2.4', '4.2.4', 'post').status, 'PASS');
  assert.equal(check.judgeVersion('4.2.5', '4.2.4', 'post').status, 'FAIL');
  assert.equal(check.judgeVersion('4.2.3', '4.2.4', 'post').status, 'FAIL');
  assert.equal(check.judgeVersion('not-a-version', '4.2.4', 'post').status, 'FAIL');
});

test('arguments: modes, the offline switch, and unknown flags', () => {
  assert.equal(check.parseArgs([]).mode, 'pre');
  assert.equal(check.parseArgs(['--mode=post']).mode, 'post');
  assert.equal(check.parseArgs(['--skip-registry']).skipRegistry, true);
  assert.throws(() => check.parseArgs(['--nope']));
});

test('PK-4: the sentence the check looks for is the one the package really shows a new person', () => {
  const { signInMessage } = require('../../lib/mcp-signin');
  const text = signInMessage({ link: 'https://x.example/l', code: 'C-1', expiresAt: Date.now() + 600000 });
  assert.ok(text.includes(check.NEW_PERSON_SENTENCE));
  assert.doesNotMatch(text, /terminal|xlsx-for-ai login/i);
});

test('the check script is not part of the published files (it is for this repo and its CI only)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.files.includes('scripts/front-door-check.js'));
});
