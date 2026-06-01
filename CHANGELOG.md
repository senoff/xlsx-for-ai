# Changelog

All notable changes to xlsx-for-ai are documented here.

The 2.x line (this branch: `2.0-beta`) is a re-architecture of the 1.5.x line.
The 1.5.x line stays maintained on `main` — existing users keep working without upgrading.

---

## [Unreleased] — Security hardening (2026-06-01)

### Security

**H1 — MCP file-read containment (fileToB64 extension allowlist)**
`fileToB64` now requires the resolved path to exist and have a spreadsheet
extension (`.xlsx`, `.xls`, `.xlsm`, `.xlsb`, `.csv`, `.ods`, `.fods`,
`.numbers`, `.tsv`). Any MCP tool call pointing at a non-spreadsheet path
(e.g. `/etc/passwd`, SSH keys, config files) is rejected with a clear
`DISALLOWED_EXTENSION` error before any I/O occurs.

**H2 — `xlsx_write` spec_path containment**
`spec_path` reads in `xlsx_write` now require the path to exist and have a
`.json` extension. Non-JSON files are rejected even if JSON-shaped, preventing
exfiltration of sensitive JSON-format files (AWS credentials, Claude config,
etc.) via the write tool path.

**H3 — Slack and Teams tokens via environment variables**
`xlsx_post_slack` and `xlsx_post_teams` no longer require live tokens as MCP
tool arguments (which appear in MCP client conversation logs). Token intake is
now env-var first: `SLACK_BOT_TOKEN` for Slack, `TEAMS_GRAPH_TOKEN` for Teams.
Passing tokens via tool arguments is still accepted for backward compatibility,
but is now documented as the legacy path that exposes tokens in conversation
history. A clear `MISSING_TOKEN` error fires if neither env var nor arg is set.

---

## [2.0.0] - 2026-05-08

First stable 2.x release. Promotes `2.0.0-beta.3` to `latest` on npm with no
code changes — every line below is identical to beta.3, which has been
exercised end-to-end against the live hosted API at `api.xlsx-for-ai.dev`.

**Breaking change vs 1.5.x:** the local heavy-engine path is gone from this
package. `xlsx-for-ai-mcp` now relays to the hosted API. The
`cursor-reads-xlsx` bin alias is preserved. Users who need the old
local-engine behavior should pin `xlsx-for-ai@1.5.4`.

**What's gated off in this release** (server-side, awaiting Phase 5):

- Raw-bytes capture (`CAPTURE_R2_ENABLED`) — default `false`
- Success-sampling capture (`CAPTURE_SUCCESS_RATE`) — default `0.0`
- `full_bytes` capture-consent level — returns `402 tier_upgrade_required`
  until paid tiers exist
- All paid tiers (Pro / Ultra) — not yet active

The free tier is the entire active surface for 2.0.0.

---

## [2.0.0-beta.3] - 2026-05-07

### Data flywheel infrastructure (server-side, Layers 1–3)

**Layer 1 — Structural fingerprints** (ships live, no privacy delta):

- All 6 tool routes now extract workbook feature flags and structural metrics and write them to `request_log` alongside every audit row.
- Feature flags detected: `uses_LAMBDA`, `uses_dynamic_arrays`, `uses_x14_cf`, `uses_threaded_comments`, `uses_mip_labels`, `uses_pivot_cache`, `uses_named_ranges`, `uses_slicers`, `uses_timelines`.
- New `request_log` columns: `feature_flags TEXT[]`, `formula_count INTEGER`, `defined_names_count INTEGER`, `max_sheet_rows INTEGER`, `max_sheet_cols INTEGER`, `error_subclass TEXT`.
- Migration: `src/db/migrations/2026-05-07-fingerprints.sql` (safe `ADD COLUMN IF NOT EXISTS`).
- Admin stats (`GET /api/v1/admin/stats`) now includes `fingerprints` section with `feature_flag_counts_last_7d`, `error_subclass_counts_last_7d`, `formula_count_distribution_last_7d`, `max_sheet_rows_distribution_last_7d`.

**Layer 2 — Error-triggered raw-bytes capture** (code ships, gated behind `CAPTURE_R2_ENABLED=false` default):

- On error (5xx, hardening trip, engine exception), workbook bytes are auto-redacted via the same `xlsx_redact` transform (cell values stripped, structure preserved), then written to R2 at `captures/<YYYY-MM-DD>/<request_id>.xlsx`.
- New config keys: `CAPTURE_R2_ENABLED`, `CAPTURE_R2_BUCKET`, `CAPTURE_R2_ACCESS_KEY_ID`, `CAPTURE_R2_SECRET_ACCESS_KEY`, `CAPTURE_R2_ENDPOINT`, `CAPTURE_TTL_DAYS`.
- Opt-out header: `X-XFA-Privacy: strict` skips capture entirely (checked before any capture work).
- `GET /api/v1/admin/captures` endpoint: lists recent capture metadata (no bytes, no signed URLs).
- R2 bucket lifecycle rule (30-day expiration) documented in DEPLOY.md.

**Layer 2.5 — Success-sampling capture** (code ships, gated behind `CAPTURE_SUCCESS_RATE=0.0` default):

- On successful calls, a configurable sampling rate (`CAPTURE_SUCCESS_RATE` float 0.0–1.0) triggers capture.
- Rare-feature boost: `CAPTURE_RARE_FEATURE_BOOST` (default 5.0) multiplies the base rate for workbooks with `uses_LAMBDA`, `uses_dynamic_arrays`, `uses_x14_cf`, `uses_threaded_comments`, or `uses_mip_labels`. Ensures corpus coverage of uncommon features even at low base rates.
- Capture reason tagged in R2 object metadata: `error` | `success_sample` | `hardening`.

**Layer 3 — Replay pipeline** (script ready, idle until Layer 2 accumulates data):

- `scripts/replay-corpus.ts`: fetches captures from R2, replays them against a local server, compares against stored snapshots, reports a regression matrix.
- `npm run replay-corpus` added to package.json.

**Output snapshots:**

- Every capture now also writes a snapshot JSON to R2 at `snapshots/<date>/<request_id>.json` with the rendered output text, output hash, engine version, and input hash. This is the baseline for engine-swap regression testing.

**Engine-version tagging:**

- `engine_version TEXT` column added to `request_log`. Populated on every audit write from a cached startup read of `@protobi/exceljs/package.json`. Migration: `src/db/migrations/2026-05-07-engine-version.sql`.

**Cross-engine validation:**

- `scripts/cross-engine-replay.ts`: replays captured workbooks through both `@protobi/exceljs` and `@cj-tech-master/excelts` and reports diffs.
- `npm run cross-engine` added.
- `@cj-tech-master/excelts` added as a devDependency (not a runtime dep).
- Reports written to `cross-engine-reports/<date>.md`.

**Capture consent levels:**

- New `clients.capture_consent_level TEXT` column (default `redacted_only`, values: `redacted_only` | `full_bytes` | `none`). Migration: `src/db/migrations/2026-05-07-consent-level.sql`.
- New endpoint `PATCH /api/v1/clients/me/consent`. Free tier can set `redacted_only` or `none`. `full_bytes` is tier-gated (requires Pro/Ultra, not yet active — Phase 5).
- `captureWorkbook()` respects the consent level: `none` skips capture, `full_bytes` persists raw bytes.

**Coverage audit:**

- `scripts/coverage-audit.ts`: counts captures per feature flag and compares against minimum targets in `config/coverage-targets.json`. Reports gaps.
- `npm run coverage-audit` added.

### Privacy commitment update

- PRIVACY.md updated to describe Layer 2 behavior, Layer 2.5 success-sampling, and the three consent levels (`redacted_only`, `full_bytes`, `none`) including the `PATCH /api/v1/clients/me/consent` endpoint.
- All changes are server-side; npm client surface unchanged — version stays at `2.0.0-beta.3`.

### Client

- **`--privacy=strict` CLI flag**: sets `XFA_PRIVACY=strict` for the session, adding `X-XFA-Privacy: strict` to all API requests.
- **`XFA_PRIVACY=strict` env var**: `lib/client.js` reads this and adds the header on every request.

---

## [2.0.0-beta.2] - 2026-05-06

See git log for beta.2 changes.

---

## [2.0.0-beta.1] - 2026-05-05

### Architecture

**Thin npm client (~200 lines) over a hosted API.** The npm package is now a relay. All rendering, formula evaluation, schema inference, PII detection, and semantic diff run server-side at `xlsx-for-ai-server.fly.dev`. Engine IP no longer ships in the npm package.

### New

- **6 MCP tools** registered via stdio transport:
  - `xlsx_read` — read a workbook (text / JSON / markdown). Free tier. Local fallback when API unreachable.
  - `xlsx_list_sheets` — list sheet names and metadata. Free tier.
  - `xlsx_schema` — infer column types, nullable flags, header row, sample values per sheet. Free tier.
  - `xlsx_diff` — semantic diff between two workbooks; cell-level deltas, formula changes, structural shifts. Plus tier.
  - `xlsx_write` — create or update a workbook from a structured spec; multi-sheet, formulas, named ranges. Plus tier.
  - `xlsx_redact` — redact PII from a workbook; server-side detection; returns redacted copy and audit manifest. Plus tier.

- **Anonymous UUID client registration.** First run calls `POST /api/v1/clients` with platform and version; server returns a UUID + API key stored in `~/.xlsx-for-ai/config.json`. No email, no signup.

- **Server-mediated processing.** Every tool call (except local fallback) relays file bytes over HTTPS to the hosted API. Files are processed in memory and not retained beyond the request. See [PRIVACY.md](PRIVACY.md).

- **Local read fallback.** `xlsx_read` falls back to a local engine (`@protobi/exceljs`, optional dependency) if the API is unreachable or returns 5xx. All other tools fail clearly with a "needs API connectivity" error. Nothing leaves the machine during fallback.

- **Mechanism #1 — Engineered agent-to-agent virality.** Every tool response includes:
  - A citation footer: `Generated by xlsx-for-ai 2.0.0. Install: npm i -g xlsx-for-ai · https://xlsx-for-ai.dev`
  - A `_meta` block: `{ tool, version, tier, request_id, powered_by: "xlsx-for-ai" }`
  - Brand-rich tool descriptions in `tools/list` — agents reading transcripts learn what xlsx-for-ai does.

- **Node 22+ required.** Uses native `fetch` (no polyfill). 1.5.x line on `main` continues supporting Node 18+.

### Removed

- **In-package engine dependency.** `@protobi/exceljs` moved from `dependencies` to `optionalDependencies`. Install it explicitly if you need the local read fallback.

- **1.5.x non-commodity features** (pruned before the 2.0 cut to reduce IP exposure on the public npm package):
  - `redactWorkbook` PII detection heuristics — moved server-side.
  - Region-detection scoring algorithm — moved server-side.
  - Bug-report sanitizer — moved server-side.

### Breaking

- **Node 22+ required.** `engines.node` is now `>=22`.
- **Rendering is server-side.** The npm package no longer ships a usable local engine for write, diff, or redact. Those tools require API connectivity.
- **CLI output format may differ.** The CLI now relays to the hosted API; output is server-rendered. Minor formatting differences from 1.5.x are expected.
- **`--list-sheets`, `--schema`, `--diff` CLI flags removed.** These capabilities moved to MCP tools (`xlsx_list_sheets`, `xlsx_schema`, `xlsx_diff`).
- **`--export-redacted-workbook` removed.** Moved to `xlsx_redact` MCP tool.

### Migration from 1.5.x

The 1.5.x line on `main` is frozen and continues to work. To upgrade to 2.0:

```bash
npm install -g xlsx-for-ai@2.0.0-beta.1
```

Existing `~/.xlsx-for-ai/config.json` is extended in place — telemetry consent is preserved. On first 2.0 run, the client will register a new UUID and API key (added to the existing config file).

---

## [1.5.4] and earlier

See the `main` branch for the 1.5.x changelog. The 1.5.x line is maintained separately and will receive security patches but no new features.
