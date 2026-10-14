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
  assert.ok(start >= 0, 'publish job not found');
  const end = src.indexOf('\n  post_publish_smoke:');
  assert.ok(end > start, 'job after publish (post_publish_smoke) not found');
  const job = src.slice(start, end);
  const stepsAt = job.indexOf('\n    steps:\n');
  assert.ok(stepsAt >= 0, 'publish job has no steps');
  const lines = job.slice(stepsAt).split('\n').filter((l) => !/^\s*#/.test(l));
  const steps = [];
  for (const line of lines) {
    const m = /^      - (?:name: (.*))?/.exec(line);
    if (m) steps.push({ name: m[1] || '', text: line + '\n' });
    else if (steps.length) steps[steps.length - 1].text += line + '\n';
  }
  return steps;
}


// The ONLY accepted shape of the check step: a name and exactly this one run line. An allowlist,
// so no shell trick (|| echo, ; exit 0, a wrapper, a folded scalar) or if:/continue-on-error can
// be added without this test going red.
const DOOR_RUN = /^        run: node scripts\/front-door-check\.js --mode=pre$/;

function doorStepIndex(steps) {
  return steps.findIndex((s) => s.text.split('\n').some((l) => DOOR_RUN.test(l)));
}

// The real publish step: the one with id: publish whose run block starts a line with npm publish.
function publishStepIndex(steps) {
  return steps.findIndex(
    (s) => /^        id: publish$/m.test(s.text) && /^          npm publish\b/m.test(s.text),
  );
}

test('publish job runs the front-door check before npm publish', () => {
  const steps = publishJobSteps(fs.readFileSync(WORKFLOW, 'utf8'));
  const door = doorStepIndex(steps);
  const pub = publishStepIndex(steps);
  assert.ok(door >= 0, 'no front-door check step in the publish job');
  assert.ok(pub >= 0, 'no npm publish step in the publish job');
  assert.ok(door < pub, 'front-door check must come before npm publish');
});

test('the front-door step is exactly a name plus the one run line (cannot be skipped or swallowed)', () => {
  const steps = publishJobSteps(fs.readFileSync(WORKFLOW, 'utf8'));
  const door = steps[doorStepIndex(steps)];
  assert.ok(door, 'front-door step missing');
  const body = door.text.split('\n').filter((l) => l.trim() !== '');
  assert.equal(body.length, 2, 'front-door step must be only a name line and one run line: ' + JSON.stringify(body));
  assert.match(body[0], /^      - name: /);
  assert.match(body[1], DOOR_RUN);
});
