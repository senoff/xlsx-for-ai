'use strict';

/**
 * XLS-4525 (B1-29): the README must name every host the package claims,
 * each with its own setup section, including Claude Desktop.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

const HOSTS = ['Claude Code', 'Claude Desktop', 'Cursor', 'Continue', 'Codex CLI', 'Zed', 'Windsurf'];

for (const host of HOSTS) {
  test(`README has a setup section for ${host}`, () => {
    assert.match(README, new RegExp(`^### ${host}$`, 'm'));
  });
}

test('README Claude Desktop section gives the real server name, command and config path', () => {
  const start = README.indexOf('### Claude Desktop');
  const end = README.indexOf('### Cursor');
  assert.ok(start >= 0 && end > start);
  const section = README.slice(start, end);
  assert.match(section, /"xfa"/);
  assert.match(section, /"command": "xlsx-for-ai-mcp"/);
  assert.ok(section.includes('claude_desktop_config.json'));
});
