'use strict';

// XLS-4521 (B1-14): only CI=true, GITHUB_ACTIONS=true and XLSX_FOR_AI_CI=1 mean
// an automated run. A bare CI=1 (a person's agent shell or Docker image) does not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLEAN = { CI: undefined, GITHUB_ACTIONS: undefined, XLSX_FOR_AI_CI: undefined, XFA_NO_AUTO_UPDATE: undefined };

async function withEnv(env, fn) {
  const all = { ...CLEAN, ...env };
  const saved = {};
  for (const k of Object.keys(all)) {
    saved[k] = process.env[k];
    if (all[k] === undefined) delete process.env[k]; else process.env[k] = all[k];
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(all)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

function freshUpgrade() {
  delete require.cache[require.resolve('../../lib/auto-upgrade')];
  return require('../../lib/auto-upgrade');
}

const CASES = [
  [{ CI: '1' }, false],
  [{ CI: 'yes' }, false],
  [{}, false],
  [{ CI: 'true' }, true],
  [{ GITHUB_ACTIONS: 'true' }, true],
  [{ XLSX_FOR_AI_CI: '1' }, true],
];

for (const [env, expected] of CASES) {
  const label = JSON.stringify(env);
  test(`isAutomatedRun ${label} -> ${expected}`, async () => {
    await withEnv(env, () => {
      const { isAutomatedRun } = require('../../lib/config');
      assert.equal(isAutomatedRun(), expected);
    });
  });

  test(`register.js isCiEnvironment ${label} -> ${expected}`, async () => {
    await withEnv(env, () => {
      const { isCiEnvironment } = require('../../lib/register');
      assert.equal(isCiEnvironment(), expected);
    });
  });

  test(`auto-upgrade checkForUpgrade ${label} ${expected ? 'skips as ci' : 'does not skip as ci'}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-auto-'));
    try {
      await withEnv({ ...env, XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '3.1.0' }, async () => {
        const { checkForUpgrade } = freshUpgrade();
        const r = await checkForUpgrade({ currentVersion: '3.1.0', log: () => {}, noticeOnly: true });
        if (expected) assert.deepEqual(r, { skipped: 'ci' });
        else assert.notEqual(r && r.skipped, 'ci');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('XFA_NO_AUTO_UPDATE=1 still opts out first, whatever the CI variables are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-auto-'));
  try {
    for (const env of [{}, { CI: '1' }, { CI: 'true' }]) {
      await withEnv({ ...env, XFA_NO_AUTO_UPDATE: '1', XFA_CONFIG_DIR: dir, XFA_LATEST_VERSION: '3.1.0' }, async () => {
        const { checkForUpgrade } = freshUpgrade();
        const r = await checkForUpgrade({ currentVersion: '3.1.0', log: () => {}, noticeOnly: true });
        assert.deepEqual(r, { skipped: 'opt-out' });
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
