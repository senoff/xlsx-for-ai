'use strict';

// XLS-10521: a bytes-in tool's own arguments (category_map, selection, ...) must reach the
// service; the relay used to forward only the file, `options` and `filename`.
const test = require('node:test');
const assert = require('node:assert');

const realFetch = global.fetch;

test('relay sends a bytes-in tool its own arguments, and keeps the client-only keys off the wire', async () => {
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  process.env.XLSX_FOR_AI_KEY = 'test-key';
  try {
    const { dispatchTool } = require('../../mcp.js');
    await dispatchTool('xlsx_pii_clean', { file_b64: 'AAAA', selection: { all: true }, mode: 'as_copy' });
    await dispatchTool('shopify_ebay_feed', {
      file_b64: 'AAAA', category_map: { A: { category_id: '1', condition_id: '1000' } }, options: { location: 'US' },
    });
    assert.deepStrictEqual(sent[0].body.selection, { all: true });
    assert.strictEqual(sent[0].body.mode, 'as_copy');
    assert.strictEqual(sent[0].body.file_b64, 'AAAA');
    assert.deepStrictEqual(sent[1].body.category_map, { A: { category_id: '1', condition_id: '1000' } });
    assert.strictEqual(sent[1].body.options.location, 'US');
    await dispatchTool('xlsx_pii_clean', { file_b64: 'AAAA', selection: {}, bogus: 1 });
    assert.ok(!('bogus' in sent[2].body));
    for (const s of sent) assert.ok(!('out_path' in s.body) && !('file_path' in s.body));
  } finally {
    global.fetch = realFetch;
    delete process.env.XLSX_FOR_AI_KEY;
  }
});
