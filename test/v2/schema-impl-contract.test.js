/**
 * Schema<->impl contract: every tool must be callable EXACTLY per its own
 * published (served) inputSchema.  XLS-973 (xlsx_eval) + XLS-873 (xlsx_write).
 *
 * The npm connector publishes ONE schema to the agent (tools/list) and enforces
 * ANOTHER contract when the call arrives (validateToolArgs + dispatchTool). When
 * those disagree, a schema-following client is locked out: it sends what the
 * published schema asked for, and the client-side gate rejects it. That is not
 * hypothetical — it is the reproduced production failure:
 *
 *     xlsx_eval: missing required argument "file_path". Check the tool's input
 *     schema; the workhorse case is file_path as a path string (NOT bytes).
 *
 * Root cause: the live catalog is `mergeTools(remoteFromServer, bakedTOOLS)`.
 * The hosted /api/v1/tools/list now returns a FULL inputSchema per tool — the
 * raw route contract, which requires `file_b64` (bytes). The old merge spread
 * `{...baked, ...remote}` let that overwrite the baked `file_path` schema the
 * connector's dispatch actually implements. So the AGENT sees file_b64, sends
 * file_b64, and validateToolArgs (bound to the baked file_path contract) throws.
 *
 * These tests pin the invariant AND prove they have teeth: the mutation control
 * reproduces the pre-fix merge and asserts the SAME contract check goes red.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS, validateToolArgs } = require('../../mcp.js');
const { _internal: { mergeTools } } = require('../../lib/discover.js');

/**
 * Simulate the hosted server's CURRENT /api/v1/tools/list: it returns a full
 * inputSchema per tool. For the xlsx_* workhorses that raw route contract
 * requires `file_b64` (bytes) — the exact shape that, spread over the baked
 * file_path schema, produced the drift.
 */
function serverManifest(tools) {
  return tools.map((t) => ({
    name: t.name,
    category: 'analysis',
    maturity_state: 'ga',
    inputSchema: {
      type: 'object',
      required: ['file_b64'],
      properties: { file_b64: { type: 'string' } },
    },
  }));
}

/** Minimal args that SATISFY a schema's required[] — what a schema-follower sends. */
function argsPerSchema(schema) {
  const args = {};
  for (const f of (schema.required || [])) {
    if (f.includes('path')) args[f] = '/tmp/contract-fixture.xlsx';       // a path string
    else if (f === 'spec') args[f] = { sheets: [] };                       // xlsx_write
    else if (f === 'file_b64' || f.endsWith('_b64')) args[f] = 'Zg==';    // bytes
    else args[f] = 'x';                                                    // predicates/group_by/etc.
  }
  return args;
}

// Every baked tool that declares a required[] — i.e. every tool the connector
// both advertises and locally validates. Derived, not hand-listed, so a newly
// added tool is covered automatically (the "sweep the class" the card asks for).
const KNOWN = TOOLS.filter((t) => t.inputSchema && Array.isArray(t.inputSchema.required));

// Every baked tool that carries an inputSchema — the full class the merge can
// clobber (xlsx_write has no top-level required[], so it is NOT in KNOWN, but it
// still has an inputSchema the merge must preserve — this is the XLS-873 case).
const SCHEMA_TOOLS = TOOLS.filter((t) => t.inputSchema);

test('sanity: the tool set is non-trivial and includes the two named tools', () => {
  assert.ok(KNOWN.length >= 15, `expected the full workhorse set, got ${KNOWN.length}`);
  const bakedNames = new Set(TOOLS.map((t) => t.name));
  assert.ok(bakedNames.has('xlsx_eval'), 'xlsx_eval (XLS-973) is a baked tool');
  assert.ok(bakedNames.has('xlsx_write'), 'xlsx_write (XLS-873) is a baked tool');
  // xlsx_eval gates via required[]; xlsx_write via schema-preservation only.
  assert.ok(KNOWN.some((t) => t.name === 'xlsx_eval'), 'xlsx_eval has a required[] the client validates');
});

test('merge preserves each baked tool\'s own inputSchema — remote never overwrites it (XLS-873 incl. xlsx_write)', () => {
  const merged = mergeTools(serverManifest(TOOLS), TOOLS);
  const byName = new Map(merged.map((t) => [t.name, t]));
  for (const baked of SCHEMA_TOOLS) {
    const served = byName.get(baked.name);
    assert.ok(served, `${baked.name} present in the served catalog`);
    assert.deepStrictEqual(
      served.inputSchema, baked.inputSchema,
      `${baked.name}: the served inputSchema must be the baked one the client implements, ` +
      `not the hosted route's raw contract — else the tool is uncallable as advertised`
    );
  }
});

test('served schema for every tool is callable per its own contract (no schema<->impl drift)', () => {
  // The REAL production path: merge the hosted manifest over the baked set.
  const merged = mergeTools(serverManifest(TOOLS), TOOLS);
  const byName = new Map(merged.map((t) => [t.name, t]));

  for (const baked of KNOWN) {
    const served = byName.get(baked.name);
    assert.ok(served, `${baked.name} present in the served catalog`);
    assert.ok(served.inputSchema && Array.isArray(served.inputSchema.required),
      `${baked.name}: served entry has an inputSchema (else Claude Desktop drops the array)`);

    // Build args EXACTLY per the published/served schema, then hand them to the
    // very gate that rejected the live call. A schema-following client must pass.
    const args = argsPerSchema(served.inputSchema);
    assert.doesNotThrow(
      () => validateToolArgs(baked.name, args),
      `${baked.name}: a client following the PUBLISHED schema (${JSON.stringify(served.inputSchema.required)}) ` +
      `must satisfy the connector's own validation — schema and impl agree`
    );
  }
});

test('MUTATION CONTROL: the pre-fix merge (remote inputSchema wins) reintroduces the drift → proves teeth', () => {
  // Reproduce the exact old line: `out.push({ ...baked, ...remote })` with no
  // inputSchema carve-out. If mergeTools ever regresses to this, the assertion
  // in the test above turns red — this block proves that red is real.
  const remote = serverManifest(TOOLS);
  const bakedByName = new Map(TOOLS.map((t) => [t.name, t]));
  const preFix = remote.map((t) => ({ ...bakedByName.get(t.name), ...t }));
  const byName = new Map(preFix.map((t) => [t.name, t]));

  // (a) XLS-973 class — validateToolArgs rejects a schema-following call.
  const uncallable = [];
  for (const baked of KNOWN) {
    const served = byName.get(baked.name);
    const args = argsPerSchema(served.inputSchema);   // {file_b64: ...}
    try {
      validateToolArgs(baked.name, args);
    } catch (e) {
      if (e.code === 'MISSING_REQUIRED_ARG') uncallable.push(baked.name);
    }
  }
  assert.ok(uncallable.includes('xlsx_eval'),
    'pre-fix merge must make xlsx_eval (XLS-973) uncallable — the reproduced defect');
  assert.ok(uncallable.length > 0,
    `pre-fix merge must reintroduce the uncallable drift for >=1 tool; got ${uncallable.length}. ` +
    `If this is 0, the fix is not load-bearing and the contract test above has no teeth.`);

  // (b) XLS-873 class — the served schema is the raw route contract, not the
  //     baked one the client implements. Assert the schema-preservation
  //     invariant FAILS under the old merge for the named write tool.
  const writeBaked = TOOLS.find((t) => t.name === 'xlsx_write');
  const writeServed = byName.get('xlsx_write');
  assert.notDeepStrictEqual(
    writeServed.inputSchema, writeBaked.inputSchema,
    'pre-fix merge must overwrite xlsx_write (XLS-873) baked schema with the remote one — the reproduced drift'
  );
});
