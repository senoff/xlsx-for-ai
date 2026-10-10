'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SERVER_KEY, TOOL_PREFIX, OUTPUT } = require('../../scripts/plugin/generate-session-start.js');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'claude-code-plugin');
const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.mcp.json'), 'utf8'));

const OLD_PREFIX = 'mcp__plugin_xlsx-for-ai_xlsx-for-ai__';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('.mcp.json declares exactly one server and its key is the one the generator uses', () => {
  assert.deepEqual(Object.keys(mcp.mcpServers), [SERVER_KEY]);
  assert.equal(SERVER_KEY, 'spreadsheets');
});

test('the server key is valid inside a tool-name segment', () => {
  assert.match(SERVER_KEY, /^[A-Za-z0-9_-]+$/);
});

test('the generated session-start text uses the prefix built from the server key', () => {
  const text = fs.readFileSync(OUTPUT, 'utf8');
  assert.equal(TOOL_PREFIX, `mcp__plugin_xlsx-for-ai_${SERVER_KEY}__`);
  assert.ok(text.includes(`${TOOL_PREFIX}<name>`));
});

test('the server URL is unchanged', () => {
  assert.equal(mcp.mcpServers[SERVER_KEY].url, 'https://api.xlsx-for-ai.dev/mcp');
});

test('no file in the plugin directory still uses the old tool-name prefix', () => {
  for (const f of walk(PLUGIN_DIR)) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(OLD_PREFIX), `old prefix in ${f}`);
  }
});
