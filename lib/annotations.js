'use strict';

/**
 * MCP tool annotations — canonical source.
 *
 * Per MCP spec (2025-06-18+) tool annotations describe runtime behavior:
 *   - title           Human-readable tool name
 *   - readOnlyHint    Tool does NOT modify its environment
 *   - destructiveHint Tool may perform irreversible side-effects
 *
 * The annotations live here rather than inline on each tool definition so:
 *   1. They overlay onto tools regardless of source — static fallback,
 *      cached catalog, or freshly-fetched remote. The remote /api/v1/tools/list
 *      currently returns minimal entries; this overlay restores the
 *      annotations the wire format would otherwise drop.
 *   2. They drive manifest generation downstream (MCPB, M365 declarative
 *      agent, future OpenAPI). One annotation change → all manifests
 *      regenerate consistently.
 *
 * Classification rules:
 *   - readOnlyHint: true  → tool only reads; never writes a file or causes
 *                            an externally observable side-effect.
 *   - destructiveHint: true → tool causes an irreversible external action
 *                              (e.g., posts to a third-party system).
 *     Note: tools that write a NEW file (Save-As shape) are NOT destructive
 *     even though readOnlyHint is false — the source workbook is preserved.
 *     destructiveHint is reserved for actions that cannot be undone by
 *     deleting the output, which means external side-effects.
 */

const TOOL_ANNOTATIONS = Object.freeze({
  // ---- Reading / inspection: 35 read-only tools -------------------------
  xlsx_read:                { title: 'Read Excel file',                       readOnlyHint: true,  destructiveHint: false },
  xlsx_list_sheets:         { title: 'List Excel sheets',                     readOnlyHint: true,  destructiveHint: false },
  xlsx_schema:              { title: 'Infer Excel column types',              readOnlyHint: true,  destructiveHint: false },
  xlsx_diff:                { title: 'Diff two Excel workbooks',              readOnlyHint: true,  destructiveHint: false },
  xlsx_describe:            { title: 'Summarize Excel columns',               readOnlyHint: true,  destructiveHint: false },
  xlsx_filter:              { title: 'Filter Excel rows',                     readOnlyHint: true,  destructiveHint: false },
  xlsx_aggregate:           { title: 'Group-by aggregate Excel rows',         readOnlyHint: true,  destructiveHint: false },
  xlsx_named_ranges:        { title: 'List Excel named ranges',               readOnlyHint: true,  destructiveHint: false },
  xlsx_sort:                { title: 'Sort Excel rows',                       readOnlyHint: true,  destructiveHint: false },
  xlsx_value_counts:        { title: 'Count Excel column values',             readOnlyHint: true,  destructiveHint: false },
  xlsx_formulas:            { title: 'Inspect Excel formulas',                readOnlyHint: true,  destructiveHint: false },
  xlsx_tables:              { title: 'List Excel tables',                     readOnlyHint: true,  destructiveHint: false },
  xlsx_pivot:               { title: 'Pivot Excel data',                      readOnlyHint: true,  destructiveHint: false },
  xlsx_eval:                { title: 'Evaluate Excel formula',                readOnlyHint: true,  destructiveHint: false },
  xlsx_validate:            { title: 'Cross-engine validate Excel',           readOnlyHint: true,  destructiveHint: false },
  xlsx_data_validations:    { title: 'List Excel data-validation rules',      readOnlyHint: true,  destructiveHint: false },
  xlsx_hyperlinks:          { title: 'List Excel hyperlinks',                 readOnlyHint: true,  destructiveHint: false },
  xlsx_topology:            { title: 'Map Excel sheet topology',              readOnlyHint: true,  destructiveHint: false },
  xlsx_conditional_formats: { title: 'List Excel conditional formats',        readOnlyHint: true,  destructiveHint: false },
  xlsx_comments:            { title: 'List Excel comments',                   readOnlyHint: true,  destructiveHint: false },
  xlsx_doctor:              { title: 'Audit Excel workbook health',           readOnlyHint: true,  destructiveHint: false },
  xlsx_form_controls:       { title: 'List Excel form controls',              readOnlyHint: true,  destructiveHint: false },
  xlsx_macros:              { title: 'List Excel VBA macros',                 readOnlyHint: true,  destructiveHint: false },
  xlsx_merged_cells:        { title: 'List Excel merged cells',               readOnlyHint: true,  destructiveHint: false },
  xlsx_workbook_views:      { title: 'List Excel workbook views',             readOnlyHint: true,  destructiveHint: false },
  xlsx_print_settings:      { title: 'List Excel print settings',             readOnlyHint: true,  destructiveHint: false },
  xlsx_properties:          { title: 'Read Excel document properties',        readOnlyHint: true,  destructiveHint: false },
  xlsx_external_links:      { title: 'List Excel external links',             readOnlyHint: true,  destructiveHint: false },
  xlsx_slicers_timelines:   { title: 'List Excel slicers and timelines',      readOnlyHint: true,  destructiveHint: false },
  xlsx_pivot_tables:        { title: 'List Excel pivot tables',               readOnlyHint: true,  destructiveHint: false },
  xlsx_images:              { title: 'List Excel embedded images',            readOnlyHint: true,  destructiveHint: false },
  xlsx_charts:              { title: 'List Excel charts',                     readOnlyHint: true,  destructiveHint: false },
  xlsx_protection:          { title: 'List Excel protection settings',        readOnlyHint: true,  destructiveHint: false },
  xlsx_styles:              { title: 'List Excel cell styles',                readOnlyHint: true,  destructiveHint: false },
  xlsx_verify_stamp:        { title: 'Verify Excel integrity stamp',          readOnlyHint: true,  destructiveHint: false },
  xlsx_verify_receipt:      { title: 'Verify Excel provenance receipt',       readOnlyHint: true,  destructiveHint: false },
  xlsx_read_handle:         { title: 'Read Excel by handle',                  readOnlyHint: true,  destructiveHint: false },
  xlsx_healer_diagnose:     { title: 'Diagnose Excel external references',    readOnlyHint: true,  destructiveHint: false },
  xlsx_healer_simulate:     { title: 'Simulate Excel reference repair',       readOnlyHint: true,  destructiveHint: false },

  // ---- Writing — non-destructive: 9 Save-As-shape tools -----------------
  // Source workbook is preserved; output goes to a new path or returned bytes.
  xlsx_write:               { title: 'Write Excel file',                      readOnlyHint: false, destructiveHint: false },
  xlsx_redact:              { title: 'Redact Excel file',                     readOnlyHint: false, destructiveHint: false },
  xlsx_convert:             { title: 'Convert Excel to other format',         readOnlyHint: false, destructiveHint: false },
  xlsx_data_clean:          { title: 'Clean Excel data',                      readOnlyHint: false, destructiveHint: false },
  xlsx_stamp:               { title: 'Stamp Excel with integrity verification', readOnlyHint: false, destructiveHint: false },
  xlsx_receipt:             { title: 'Generate Excel provenance receipt',     readOnlyHint: false, destructiveHint: false },
  xlsx_healer_cure:         { title: 'Repair Excel external references',      readOnlyHint: false, destructiveHint: false },
  xlsx_healer_intent:       { title: 'Generate Excel repair-intent file',     readOnlyHint: false, destructiveHint: false },

  // ---- Stateful session write: 1 tool -----------------------------------
  // Mutates session-scoped state on the server (reversible by a follow-up call).
  xlsx_session_set_validations:
                            { title: 'Set Excel session validation rules',    readOnlyHint: false, destructiveHint: false },

  // ---- External side-effects — destructive: 2 tools ---------------------
  // A post can't be undone; the message lands in a third-party system.
  xlsx_post_slack:          { title: 'Post Excel summary to Slack',           readOnlyHint: false, destructiveHint: true },
  xlsx_post_teams:          { title: 'Post Excel summary to Teams',           readOnlyHint: false, destructiveHint: true },
});

/**
 * Overlay annotations onto an MCP-shaped tool array.
 *
 * Returns a new array with each tool extended with an `annotations` object
 * pulled from TOOL_ANNOTATIONS by name. Tools without a known annotation
 * pass through unchanged — this is intentional so that a dynamically-
 * discovered tool the client doesn't recognize still appears, just without
 * the annotation hints. The annotation map should be updated whenever
 * a new tool is added to the server.
 */
// Keys we refuse to copy from upstream annotation objects — guards against
// prototype-pollution if a remote /api/v1/tools/list ever returns hostile
// data. Our overlay map is a frozen const so it's safe to spread directly;
// the danger is only the foreign `existing` object.
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function applyAnnotations(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || typeof t.name !== 'string') return t;
    const ann = TOOL_ANNOTATIONS[t.name];
    if (!ann) return t;
    // Preserve any annotations the upstream source already carries; ours fill
    // in the gaps without clobbering richer remote data. Reject pollution
    // keys and non-plain-object inputs.
    const merged = { ...ann };
    if (t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations)) {
      for (const [k, v] of Object.entries(t.annotations)) {
        if (POLLUTION_KEYS.has(k)) continue;
        merged[k] = v;
      }
    }
    return { ...t, annotations: merged };
  });
}

/**
 * Sanitize an MCP-shaped tool array so every entry has the fields the MCP
 * spec requires for client registration: `name` (already required), plus a
 * non-empty `inputSchema` and a non-empty `description`.
 *
 * Floor strategy:
 *   - If `inputSchema` is missing or not an object, substitute the permissive
 *     `{ type: 'object' }`. Claude Desktop and other strict clients drop
 *     tools without an inputSchema; the permissive object schema is enough
 *     for them to REGISTER the tool. Real per-arg schemas are upstream
 *     (server-side /api/v1/tools/list) work; this is the unblocking floor.
 *   - If `description` is missing or empty, substitute the annotation title
 *     (if any) or a generic `xlsx-for-ai tool: <name>` so the tool surfaces
 *     in client UIs that key off description text.
 *   - Tools without a `name` field are dropped (the MCP spec requires it
 *     and dispatch would have nothing to route by anyway).
 *
 * SPM P0 2026-06-05 (mcp-toolslist-missing-inputschema). The hosted
 * /api/v1/tools/list endpoint currently returns minimal entries
 * ({name, category, maturity_state, endpoint}); the field-level mergeTools
 * upstream of this preserves the baked-in inputSchema/description for the
 * names the client ships, but server-only tools (e.g. newer additions not
 * yet in the baked TOOLS array) still need a floor so they don't poison
 * the whole tools/list.
 */
function sanitizeForMcp(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) continue;
    const fixed = { ...t };
    if (!fixed.inputSchema || typeof fixed.inputSchema !== 'object' || Array.isArray(fixed.inputSchema)) {
      fixed.inputSchema = { type: 'object' };
    }
    if (!fixed.description || typeof fixed.description !== 'string') {
      const annTitle = fixed.annotations && typeof fixed.annotations.title === 'string'
        ? fixed.annotations.title
        : null;
      fixed.description = annTitle || `xlsx-for-ai tool: ${fixed.name}`;
    }
    out.push(fixed);
  }
  return out;
}

module.exports = {
  TOOL_ANNOTATIONS,
  applyAnnotations,
  sanitizeForMcp,
};
