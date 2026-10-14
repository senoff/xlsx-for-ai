'use strict';

/**
 * XLS-4527 (audit B3-7): a release cannot reach `npm publish` unless the package-owned
 * front-door check passed. The check is a step of the publish job, ahead of the publish step,
 * with no condition and no continue-on-error, so a non-zero exit stops the job there.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'publish.yml');

/** Split the publish job's step list into { name, text } blocks, in file order. */
function publishJobSteps(src) {
  const start = src.indexOf('\n  publish:\n');
  const end = src.indexOf('\n  post_publish_smoke:');
  assert.ok(start >= 0 && end > start, 'publish job not found');
  const job = src.slice(start, end);
  const stepsAt = job.indexOf('\n    steps:\n');
  assert.ok(stepsAt >= 0, 'publish job has no steps');
  const lines = job.slice(stepsAt).split('\n');
  const steps = [];
  for (const line of lines) {
    const m = /^      - (?:name: (.*))?/.exec(line);
    if (m) steps.push({ name: m[1] || '', text: line + '\n' });
    else if (steps.length) steps[steps.length - 1].text += line + '\n';
  }
  return steps;
}

test('publish job runs the front-door check before npm publish', () => {
  const steps = publishJobSteps(fs.readFileSync(WORKFLOW, 'utf8'));
  const door = steps.findIndex((s) => /node scripts\/front-door-check\.js/.test(s.text));
  const pub = steps.findIndex((s) => /(^|\n)\s*(run:\s*)?npm publish\b/.test(s.text));
  assert.ok(door >= 0, 'no front-door check step in the publish job');
  assert.ok(pub >= 0, 'no npm publish step in the publish job');
  assert.ok(door < pub, 'front-door check must come before npm publish');
});

test('the front-door step cannot be skipped or swallowed', () => {
  const steps = publishJobSteps(fs.readFileSync(WORKFLOW, 'utf8'));
  const door = steps.find((s) => /node scripts\/front-door-check\.js/.test(s.text));
  assert.ok(door);
  assert.ok(!/^\s+if:/m.test(door.text), 'front-door step must have no if: condition');
  assert.ok(!/continue-on-error/.test(door.text), 'front-door step must not continue on error');
  assert.ok(!/\|\|\s*true/.test(door.text), 'front-door step must not swallow a failure');
});
