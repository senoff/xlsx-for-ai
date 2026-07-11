/**
 * The generic relay must honor the input contract the CATALOG advertises.
 *
 * A relayed tool declares one of two shapes:
 *   file_path — a path the client reads and encodes (the xlsx_* workhorses)
 *   file_b64  — bytes the caller already holds (every shopify_* tool: `file_b64` +
 *               `filename`, and NO `file_path` in the schema)
 *
 * The relay assumed `file_path` unconditionally, so for the whole second class it called
 * `fileToB64(undefined)` → `path.resolve(undefined)` → TypeError, at the MCP boundary,
 * where the error sanitizer collapsed it to an opaque "tool failed — see server-side
 * logs". Consequences, all of which this file pins:
 *
 *   1. The request NEVER LEFT THE MACHINE. The server was healthy the entire time
 *      (a direct POST returns 200), so no server-side log existed to go read.
 *   2. All five shopify_* tools were advertised by the live catalog and could never be
 *      dispatched — on the agent-mediated surface, which is the PRIMARY product UX.
 *
 * So the assertion is not "it doesn't throw" — it is that the bytes REACH THE WIRE. A
 * test that only caught the throw would pass on a relay that quietly dropped the file.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { dispatchTool } = require('../../mcp.js');

const B64 = Buffer.from('Handle,Title\nwidget,Blue Widget\n').toString('base64');

/** Run a dispatch with `fetch` stubbed, and return every request that reached the wire. */
async function captureWire(name, args) {
  const wire = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    wire.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await dispatchTool(name, args);
  } finally {
    globalThis.fetch = realFetch;
  }
  return wire;
}

// The bytes-in class. Every one of these has `file_b64` + `filename` and no `file_path`.
const BYTES_IN_TOOLS = [
  'shopify_products_import_fix',
  'shopify_products_import',
  'shopify_collections_import',
  'shopify_inventory_import',
  'shopify_url_redirects_import',
];

for (const name of BYTES_IN_TOOLS) {
  test(`${name}: relays caller-supplied file_b64 to the wire (never demands a file_path)`, async () => {
    const wire = await captureWire(name, { file_b64: B64, filename: 'broken.csv' });

    // (1) It reached the wire at all. Before the fix this was 0 — the TypeError fired
    //     inside the relay and the call died on the user's machine.
    assert.equal(wire.length, 1, `${name} never reached the wire — the relay threw locally`);

    // (2) It went to THIS tool's route.
    assert.ok(
      wire[0].url.endsWith(`/api/v1/tools/${name}`),
      `${name} relayed to the wrong route: ${wire[0].url}`,
    );

    // (3) The caller's bytes arrived intact — not dropped, not re-encoded, not undefined.
    //     This is the assertion a mere "did not throw" test would miss.
    assert.equal(wire[0].body.file_b64, B64, `${name} did not forward the caller's bytes`);
    assert.equal(wire[0].body.filename, 'broken.csv', `${name} dropped the filename`);
  });
}

test('the path-in class is untouched: a file_path tool still gets read and encoded', async () => {
  // The regression guard on the other half of the contract — the fix must not have
  // turned the workhorse relay into a bytes-only path.
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(os.tmpdir(), `relay-contract-${process.pid}.csv`);
  fs.writeFileSync(p, 'a,b\n1,2\n');
  try {
    const wire = await captureWire('xlsx_list_sheets', { file_path: p });
    assert.equal(wire.length, 1, 'the path-in relay stopped reaching the wire');
    assert.equal(
      wire[0].body.file_b64,
      fs.readFileSync(p).toString('base64'),
      'the path-in relay no longer encodes the file it read',
    );
  } finally {
    fs.unlinkSync(p);
  }
});
