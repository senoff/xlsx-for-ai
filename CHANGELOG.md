# Changelog

All notable changes to xlsx-for-ai are documented here.

The 2.x line (this branch: `2.0-beta`) is a re-architecture of the 1.5.x line.
The 1.5.x line stays maintained on `main` — existing users keep working without upgrading.

---

## [2.26.1] - 2026-06-05

### Fixed

**`lib/annotations.js` was missing from the published tarball, crashing
MCP startup with `MODULE_NOT_FOUND`.**
Broken in 2.25.0 → 2.26.0. Root cause: the file was added to source at
2.25.0 (Theme MCP-annotation work) and required by `mcp.js`, but the
`package.json` `files` allowlist was never updated to include it.
`npm pack` shipped every other `lib/` module but omitted that one.
Result: Claude Desktop showed "Server disconnected" / failed to load
`xlsx-for-ai`. Fix: add `lib/annotations.js` to the `files` allowlist
+ ship a prepublish guard that scans `require('./lib/...')` against the
allowlist and refuses to publish if any required module is missing.
Last clean published version prior to this fix was 2.23.0.

### Added

**Prepublish allowlist guard — `scripts/check-publish-allowlist.js`.**
Runs on `prepublishOnly`; scans `mcp.js` + `index.js` for
`require('./lib/<name>')` and asserts every match appears in the
`files` allowlist (with .js-suffix normalization). Refuses to publish
with a clear error when a required module is missing. Kills the whole
class of bug that produced 2.25.0–2.26.0's MODULE_NOT_FOUND crash. 5
new tests cover pass / fail / .js-normalization / malformed package.json /
the live tree.

---

## [Unreleased] — Healer-deep CLI subcommand (2026-06-03)

### Added

**`xlsx-for-ai heal` CLI subcommand** — exposes the healer-deep
HTTP routes (`/api/v1/tools/xlsx_healer_diagnose` and
`/api/v1/tools/xlsx_healer_cure`) as a first-class CLI surface.
First-touch use is diagnose-only:

```sh
xlsx-for-ai heal workbook.xlsx                  # diagnose-only (default)
xlsx-for-ai heal workbook.xlsx --diagnose-only  # explicit form
xlsx-for-ai heal workbook.xlsx --format json    # structured output
```

Cure path:

```sh
xlsx-for-ai heal workbook.xlsx \
  --operation rename_move \
  --params '{"from_prefix":"file:///old/","to_prefix":"file:///new/"}' \
  [--mode as_copy|in_place] \
  [--out <path>] \
  [--format text|json]
```

`--out` defaults to `<name>-healed.xlsx` next to the source.
Refuses to overwrite the source unless `--mode in_place` is set.

Diagnostic surface returns the full DiagnosticReport — external
references (Class 1), defined-name external refs (Class 2),
Power Query connections (Class 3), `#REF!` propagation map
(Class 4), multi-hop chains (Class 5) — with per-reference
plain-English diagnosis.

Cure operations supported (10 of 11 in v1; `modernize_to_pq` is
v1.1-only pending Excel-format SPEC):

  - `rename_move`, `pattern_bulk`
  - `source_deleted_freeze` (full-grid snapshot via CachedCell
    type fidelity), `source_deleted_redirect`, `source_deleted_localize`
  - `permission_denied`, `structure_changed` (full formula rewriter),
    `format_change`, `make_standalone`
  - `chain_collapse` (with partial_cache_collapse policy + verdict
    signal when consumer cells are un-cached)

`--intent`, `--from`, `--to` are reserved for v1.1 once the
`/api/v1/tools/xlsx_healer_intent` route ships; the CLI rejects
those flags today with a clean "v1.1" message rather than a
server-side 404.

## [2.25.1] - 2026-06-03

Pre-Friday-external Tier-1 error-handling hardening — patch on top of
2.25.0 closing CRITICAL findings the per-commit diff-only grace gate
never saw (those patterns predated the new doctrine).

### Security

**MCP boundary — `out_path` extension allowlist**
`applyFileB64` now enforces `ALLOWED_WRITE_EXTENSIONS = {.xlsx, .xls,
.xlsm, .xlsb, .csv, .json}` on `path.extname(absPath)` before writing.
Tighter than the READ allowlist (no .ods/.fods/.numbers/.tsv) since
the server only emits XLSX-family bytes. A confused or malicious agent
can no longer point `out_path` at a shell-startup or executable file
to write `.sh` / arbitrary content via the response's base64 payload.

**MCP boundary — startup catalog fetch hard timeout (8s)**
`resolveCatalog(TOOLS)` now races against an 8s `setTimeout`. Previously
a network call that never resolved AND never rejected (DNS sinkhole,
TCP black hole, slow-loris-stalled response) blocked MCP server startup
indefinitely, taking every tool offline. On timeout the fallback path
(baked-in `TOOLS` from this npm package) fires as before.

**MCP boundary — error message sanitization**
`friendlyErrorMessage(toolName, code)` translates known operational
error codes (`FILE_NOT_FOUND`, `API_UNREACHABLE`, `RATE_LIMITED`, etc.)
to short, client-safe text and collapses the default branch to a
generic `<tool> failed`. Raw `err.message` from inside `dispatchTool`
no longer flows to the MCP client — it could carry absolute file
paths, upstream server stacks, or third-party HTTP response bodies,
all of which can end up in MCP client conversation logs.

**CLI — `_meta.file_b64` stripped before stdout**
`metaForStdout` deletes `file_b64` from the `_meta` object before
`JSON.stringify`-ing to stdout in the `stamp` / `verify-stamp` /
`receipt` / `verify-receipt` subcommands. The stamped/receipted
workbook is already saved to disk via the sidecar or `--out` path;
dumping its base64 to a terminal or CI log clobbered scrollback AND
leaked PII-bearing workbook contents to whatever consumes stdout.

**CLI — error sanitization at every stderr echo site**
`friendlyCliError(prefix, err)` replaces direct `${err.message}`
interpolation at every CLI error sink. Same posture as the MCP
boundary: known operational codes get short text; default is generic.
Set `XFA_DEBUG=1` to see the raw underlying message for incident
triage.

## [2.25.0] - 2026-06-03

Receipt — AI-agent provenance attestation pair-product to Stamp. Plus
the 2.24.0-staged security hardening (H1/H2/H3), fallback-read crash-class
fix for SEC XBRL→xlsx files, MCP file-size guard, options.sheet honoring,
manifest generation tooling. (2.24.0 was prepped but rolled into 2.25.0
since Receipt landed before publish.)

### Added

**Receipt — `xlsx_receipt` + `xlsx_verify_receipt` MCP tools**
Ed25519-signed claims embedded in `docProps/custom.xml` under the
`xlsx-for-ai-receipt-v1` custom-property name. Stamp + Receipt coexist
on the same workbook under different property names. The Receipt's
claims describe caller-declared agent identity + generation context
(source-file hashes, prompt hash, MCP tools called, optional description)
— attesting to "what produced this file," distinct from Stamp's "what
was checked." Honesty boundary (load-bearing per the spec/receipt.md
§7.5 audit): the server signs the caller-declared `agent.name`; it
does NOT verify the caller actually IS that agent. Cryptographic
identity binding requires per-agent issued signing keys — v1.1+ scope.
Both MCP tool descriptions AND the README call this out explicitly.

**CLI subcommands — `stamp`, `verify-stamp`, `receipt`, `verify-receipt`**
First-position subcommand dispatch in `xlsx-for-ai`:
```
xlsx-for-ai stamp <path> --checks <file.json> [--out <path>]
xlsx-for-ai verify-stamp <path>
xlsx-for-ai receipt <path> --agent <name> [--source <name>=<sha256>]...
xlsx-for-ai verify-receipt <path>
```
Sidecar default (`<name>.stamped.xlsx` / `<name>.receipted.xlsx`); `--out`
overrides. Exit codes match spec/stamp.md §4.9: 0 success / 1 verify
returned valid=false / 2 usage / 3 server / 4 local file. stdout = the
server's `_meta` object as pretty JSON; stderr = the "Wrote <path>"
confirmation. Bare `xlsx-for-ai <file.xlsx>` keeps its existing
flag-only semantics — subcommand dispatch only fires on the four new
keywords.

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

### Fixed

**Fallback-read: survive merge cells with null master value (SEC XBRL→xlsx class)**
`@protobi/exceljs`'s `cell.text` getter throws `TypeError: Cannot read properties of
null (reading 'toString')` on merge cells whose master value is null — produced by
SEC EDGAR's XBRL→xlsx converter and similar tools. The default-mode dump (no flags)
previously crashed on this class; per-sheet (`--sheet`) mode worked. New
`safeCellText` guard swallows the exact null-deref `TypeError` shape (anchored regex
matching modern V8's `Cannot read properties of null (reading 'x')` and legacy V8's
`Cannot read property 'x' of null`), rethrowing anything else so real engine bugs
still surface. Confirmed against the SEC 9-file corpus (Airbnb, Apple, Datadog,
Dropbox, GitLab, Meta, NVIDIA, Snowflake, Tesla) and the ALAB 5-file portfolio
(10-K + four 10-Q quarters); all 14 dump cleanly. Commits `2dee328`, `5e123e3`,
`0f87bb5`, `e7ca71c`, `9f66415`.

**Fallback-read: honor `options.sheet`; surface ignored options (M3)**
`fallbackRead` now filters to the requested sheet when `options.sheet` is passed
(previously ignored — agents calling `xlsx_read` with `sheet="Budget"` on a 20-sheet
workbook got all 20 sheets during API outage, producing silent context overflow and
output-shape divergence). A visible warning is prepended when fallback fires and
when options are ignored (`options.format` / `options.evaluate` remain
fallback-incompatible); `_meta.ignored_options` echoes the list. Callers can
detect fallback unambiguously via `_meta.source === 'local-fallback'`. Commit
`47d6727`.

**MCP: file-size guard on `fileToB64` (M1)**
`fileToB64` now `statSync`-checks the file before reading. Files exceeding
`XFA_MAX_FILE_MB` (default 50) are rejected with a clear error before any base64
allocation. Previously, a 200 MB workbook would allocate ~267 MB of base64 string
in Node's heap before the API call started — the 30s API timeout doesn't help
since OOM is pre-network, and in MCP-server context this kills the server process
and disconnects every connected client. TOCTOU closed by reading from the same
open fd as `statSync`. Commits `3f85cd9`, `138fce4`, `83e25f8`, `2cf23b5`.

### Changed

**MCP: tool annotations on all surfaced tools**
Every tool exposed via MCP now declares MCP annotation hints (`readOnlyHint`,
`destructiveHint`, etc.) so MCP-aware clients can render appropriate UX +
confirmation flows. Annotations live in a single-source registry; tool-list and
manifest are derived. Commit `d919dae`.

**Tooling: single-source manifest generation + `--check` drift gate**
`scripts/build-manifests.js` is the canonical source for the MCP-bundled manifest;
`--check` mode enforces no-drift between the generated artifact and what's
committed. Wired into Husky pre-commit and CI; CHECK failures block. Commits
`910020f`, `f0577d8`, `9242278`.

**`SECURITY.md` + `STATUS.md` version-table refresh**
Version-supported table updated to reflect 2.23.x current / older 2.x superseded /
1.5.x frozen / ≤1.4.x superseded. Sub-product `STATUS.md` notes clarify that
`vault-build/`, `pii-frisk-build/`, `healer-build/`, and `platform-build/` are
in-flight builds whose server-side implementations live in `xlsx-for-ai-server` —
not part of the npm package surface. Commit `d91ec56`.

**MCP: log tool catalog source to stderr on startup (L4)**
The MCP server now logs the catalog source URL on boot so operators can distinguish
between live-server vs stale-cache catalog states without diffing. Commit `da917af`.

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
