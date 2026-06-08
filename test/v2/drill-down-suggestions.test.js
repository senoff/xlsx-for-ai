'use strict';

// Regression tests for SPM SPEC 2026-06-07
// (base64-defensive-error-and-suggested-next-call), part 2 — the
// drill-down suggestion footer Bob explicitly asked for: tool outputs
// that mention follow-on tools get concrete invocations appended with
// the caller's file_path pre-filled.

const { test } = require('node:test');
const assert = require('node:assert');
const { dispatchTool } = require('../../mcp.js');

// The injectDrillDownExamples function isn't exported directly. The
// public behavior is observable through dispatchTool's wrapping of the
// generic-relay tools (xlsx_doctor falls through that path). To test
// without standing up the full HTTP layer, we mock the API base via
// XLSX_FOR_AI_API pointing at an in-process stub server.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function withStubServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const oldApi = process.env.XLSX_FOR_AI_API;
  const oldCfg = process.env.XFA_CONFIG_DIR;
  process.env.XLSX_FOR_AI_API = `http://127.0.0.1:${port}`;
  process.env.XFA_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-drill-test-'));
  // Drop the cached client module so it picks up the new env.
  delete require.cache[require.resolve('../../lib/client.js')];
  delete require.cache[require.resolve('../../lib/register.js')];
  try {
    await run();
  } finally {
    process.env.XLSX_FOR_AI_API = oldApi;
    process.env.XFA_CONFIG_DIR = oldCfg;
    server.close();
  }
}

// Helper to make a fake xlsx file so fileToB64 doesn't reject the path.
function tempXlsx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-drill-fixture-'));
  const p = path.join(dir, 'fixture.xlsx');
  // Minimal-shape ZIP that passes fileToB64's extension + size checks but
  // never actually parses — we never let it reach the engine because the
  // stub server returns directly.
  fs.writeFileSync(p, Buffer.from('PK\x03\x04synthetic'));
  return p;
}

test('drill-down footer: doctor response mentioning follow-on tools gets concrete invocations', async () => {
  const filePath = tempXlsx();
  await withStubServer(
    (req, res) => {
      // Registration call → respond with a fake api_key so subsequent
      // calls are authed.
      if (req.url === '/api/v1/clients') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          client_id: '00000000-0000-0000-0000-000000000000',
          api_key: 'xfa_test_key',
          welcome: { plan: 'free', message: '' },
        }));
        return;
      }
      if (req.url === '/api/v1/tools/xlsx_doctor') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [
            {
              type: 'text',
              text:
                'HIGH: external workbook references detected. ' +
                'Run xlsx_external_links to see the targets. ' +
                'Run xlsx_workbook_views to enumerate UI state.',
            },
          ],
          _meta: { tool: 'xlsx_doctor' },
        }));
        return;
      }
      res.writeHead(404); res.end();
    },
    async () => {
      const { dispatchTool } = require('../../mcp.js');
      const result = await dispatchTool('xlsx_doctor', { file_path: filePath });
      assert.ok(result && Array.isArray(result.content));
      const txt = result.content[0].text;
      assert.ok(txt.includes('Drill-down suggestions'),
        `expected drill-down footer; got: ${txt}`);
      assert.ok(txt.includes('xlsx_external_links'));
      assert.ok(txt.includes('xlsx_workbook_views'));
      // The path STRING (not bytes) must be in the suggestion.
      assert.ok(txt.includes(filePath),
        `pre-filled file_path missing from suggestions; got: ${txt}`);
      // The footer reinforces the correct-usage contract.
      assert.ok(txt.includes('not file bytes'));
    }
  );
});

test('drill-down footer: no follow-on tool mentions → no footer added (no-op)', async () => {
  const filePath = tempXlsx();
  await withStubServer(
    (req, res) => {
      if (req.url === '/api/v1/clients') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ client_id: '0', api_key: 'xfa_test_key', welcome: {} }));
        return;
      }
      if (req.url === '/api/v1/tools/xlsx_doctor') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text: 'All clear. No findings.' }],
          _meta: { tool: 'xlsx_doctor' },
        }));
        return;
      }
      res.writeHead(404); res.end();
    },
    async () => {
      const { dispatchTool } = require('../../mcp.js');
      const result = await dispatchTool('xlsx_doctor', { file_path: filePath });
      const txt = result.content[0].text;
      assert.ok(!txt.includes('Drill-down suggestions'),
        `expected NO footer when no tools mentioned; got: ${txt}`);
    }
  );
});

test('drill-down footer: self-reference excluded (xlsx_doctor mentions itself → no self-suggestion)', async () => {
  const filePath = tempXlsx();
  await withStubServer(
    (req, res) => {
      if (req.url === '/api/v1/clients') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ client_id: '0', api_key: 'xfa_test_key', welcome: {} }));
        return;
      }
      if (req.url === '/api/v1/tools/xlsx_doctor') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'xlsx_doctor: re-running xlsx_doctor will reproduce. Also run xlsx_workbook_views.',
            },
          ],
          _meta: { tool: 'xlsx_doctor' },
        }));
        return;
      }
      res.writeHead(404); res.end();
    },
    async () => {
      const { dispatchTool } = require('../../mcp.js');
      const result = await dispatchTool('xlsx_doctor', { file_path: filePath });
      const txt = result.content[0].text;
      // Footer should mention xlsx_workbook_views once.
      const footerStart = txt.indexOf('Drill-down suggestions');
      assert.ok(footerStart > 0);
      const footer = txt.slice(footerStart);
      assert.ok(footer.includes('xlsx_workbook_views'));
      // Self-reference must NOT appear in the suggestion lines.
      assert.ok(!footer.includes('xlsx_doctor({'),
        `self-reference should be excluded; got: ${footer}`);
    }
  );
});
