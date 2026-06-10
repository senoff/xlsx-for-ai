# Changelog

All notable changes to xlsx-for-ai are documented here.

The 2.x line (this branch: `2.0-beta`) is a re-architecture of the 1.5.x line.
The 1.5.x line stays maintained on `main` — existing users keep working without upgrading.

---

## [3.2.0] - 2026-06-10

Thin-client consolidation: completes the move to a hosted-API-only client and
standardizes the install on one canonical gesture.

### Changed

- **One canonical install gesture: the global bin, not npx.** The README MCP
  configs (Cursor, Continue, Codex CLI, Zed, Windsurf) and the top-of-file
  framing pointed at `npx -y xlsx-for-ai@latest` on every client launch;
  `lib/mcp-register.js` already treated npx entries as stale by design (the
  per-launch network/cache-staleness class we're removing). All configs now
  point at the installed `xlsx-for-ai-mcp` binary — pinned, fast, offline-capable.
- **MCP server registers under `xfa`, not `xlsx-for-ai`.** A plain
  `npm install -g xlsx-for-ai` now auto-wires the same server name the docs,
  website, and `claude mcp add` use — the `--ignore-scripts` workaround is gone.
  Registering `xfa` performs a one-time dupe migration: any lingering legacy
  `xlsx-for-ai` entry is removed in the same write, so an install never carries
  both. Uninstall removes both keys.

### Removed

- **Retired the DXT / `.mcpb` Desktop Extension surface.** Deleted
  `manifest.json` (DXT bundle manifest), `scripts/build-mcpb.sh` (the `.mcpb`
  bundler), and `.github/workflows/manifest-check.yml` (CI drift gate whose
  sole job was guarding the DXT manifest). Claude Desktop installs via the MCP
  server (`xlsx-for-ai-mcp`), not a bundled extension; the DXT path was retired
  fleet-wide on 2026-06-08. `scripts/build-manifests.js` now generates only the
  on-demand `dist/mcp-tools.json` snapshot (MSFT plugin manifest 2.4 ref).
  `prepublishOnly` no longer runs a manifest drift check, and the Husky
  pre-commit hook (whose sole job was that check) plus the `husky` devDependency
  are removed — there are no remaining git hooks.
- **Retired the offline local-read fallback.** `xlsx_read` no longer falls back
  to a local engine when the hosted API is unreachable or returns 5xx — every
  tool now requires API connectivity and fails with a clear, actionable error
  instead of silently degrading to local output. Deleted `lib/fallback-read.js`,
  dropped the `@protobi/exceljs` optional dependency, and removed the
  `FALLBACK_ENGINE_MISSING` error path from the CLI and MCP server. The
  cross-engine `xlsx_validate` check is unaffected — it runs server-side.
- **Retired the v2 local-engine supply-chain apparatus.** With parsing now
  fully server-side, the client's only runtime dependency is
  `@modelcontextprotocol/sdk`. Deleted `FORK_READINESS.md` (the
  `@protobi/exceljs` npm-account-compromise runbook — premise no longer
  applies), stripped the `exceljs-family` / `workbook-engines` / `tooling`
  Dependabot groups (none of those packages ship in the client anymore), and
  rewrote `docs/INTEGRITY_PINNING.md` + `SECURITY.md` to describe the thin-client
  threat model. The integrity-pinning CI (lockfile-as-source-of-truth, signed
  installs, silent-republish guard, audit allowlist) is unchanged — it now
  guards the SDK tree. The cross-engine parser supply-chain concern moved to the
  server repo, which owns that surveillance.

---

## [3.1.0] - 2026-06-08

Demo-funnel release. Bundles runnable sample workbooks, adds a one-command
way to get started, and aligns the package with the everything-free pivot.

### Added

- **`xlsx-for-ai samples` subcommand** — copies two bundled demo workbooks
  (`reporting-pack-v1.xlsx`, `reporting-pack-v2.xlsx`) into the current
  directory and prints paste-ready prompts (diff / validate / redact /
  doctor). `--force` overwrites; existing files are skipped. The workbooks
  ship in the published tarball under `samples/`.

### Changed

- **README** now leads with the Claude Code install path
  (`npm install -g xlsx-for-ai && claude mcp add xlsx-for-ai -- xlsx-for-ai-mcp`).
  The Claude Desktop / `.mcpb`-bundle section and the pricing table are
  removed — all 50 tools are free (10k calls/mo volume cap is the only limit).
- **`xlsx_validate` tool description** no longer advertises "PAID — Bronze /
  Silver / Gold tier required"; it's been free since server v79.

---

## [3.0.16] - 2026-06-08

Belt-and-suspenders on the base64 misread class (SPM SPEC
2026-06-07-base64-defensive-error-and-suggested-next-call). The 3.0.14
description hardening cut the misread rate but didn't guarantee it;
this release closes the failure shape with two structural defenses.

### Added

- **Defensive input-contract validation** in `dispatchTool` runs BEFORE
  any server round-trip. Two new error codes:
  - `MISSING_REQUIRED_ARG` — fires when a required field (per the
    tool's inputSchema) is missing or empty. Carries the field name
    so the friendly message can quote it.
  - `BASE64_MISREAD` — fires when a `file_path` / `file_path_a` /
    `file_path_b` / `spec_path` argument is >200 chars AND looks like
    pure base64 (no `.`, `\`, `~`, or spaces; full base64 alphabet).
    Heuristic chosen because `/` is a base64-alphabet character too —
    distinguishing on `.`/`\`/`~`/space is what catches the real case
    without false-positives on legit paths.
- **friendlyErrorMessage** gains cases for both codes — the response
  text explicitly names the offending field, restates the
  path-string-not-bytes contract, and tells the model to retry with
  `file_path` set to a path string. Turns the prior indefinite
  base64-bash-hang into a one-turn recovery.
- **Drill-down footer on triage tool outputs.** When a tool response
  mentions follow-on `xlsx_*` tool names in its findings (e.g.,
  `xlsx_doctor` references `xlsx_external_links` / `xlsx_workbook_views`),
  the client appends concrete invocations with the caller's
  `file_path` pre-filled:
  ```
  ---
  Drill-down suggestions — concrete invocations pre-filled with your file_path
  (pass the path STRING, not file bytes; the client reads the file):
  - `xlsx_workbook_views({ "file_path": "/Users/bob/foo.xlsx" })`
  - `xlsx_external_links({ "file_path": "/Users/bob/foo.xlsx" })`
  ```
  Doubles as a correct-usage exemplar the agent imitates on the next
  call — structural mitigation against the misread.

### Tests

`test/v2/base64-defensive.test.js` (10 cases):
- BASE64_MISREAD / MISSING_REQUIRED_ARG friendly-message shape.
- Missing / empty / base64-shaped / multi-path-field validation.
- False-positive guards: normal absolute path, tilde path, short
  string with no separators (all pass validation).

`test/v2/drill-down-suggestions.test.js` (3 cases):
- Findings mentioning follow-on tools → footer with pre-filled
  invocations.
- No tools mentioned → no footer (no-op).
- Self-reference excluded (`xlsx_doctor` mentioning itself doesn't
  suggest `xlsx_doctor`).

106 total tests pass.

---

## [3.0.14] - 2026-06-07

Doc-class — **demo-blocking**: the agent was inventing a base64-
encoding step before any tool call ("the doctor tool needs the file
base64-encoded — let me encode it"), then going off to run `base64`
in bash and hanging. No tool call ever reached the connector.
Reproduced live in two sessions including a clean cwd with no
project CLAUDE.md.

Root cause: `xlsx_write.base_file_b64` is described as "Optional
base64 of an existing .xlsx to edit-in-place" — the model
generalized "xlsx tools speak base64" and applied it to every
input, including read/analysis tools whose only input is a file
path. The `_meta.file_b64` output mentions reinforced the wrong
mental model.

### Fixed

- **Tightened every `file_path` property description** (37 sites
  across the read/analysis/write/integrity surfaces) from the bare
  "Absolute path to the .xlsx file." to:
  `"Absolute path to the .xlsx file. Pass the path string AS-IS — do NOT read, open, or base64-encode the file; the client handles all file I/O. The base64 surface in this connector is OUTPUT-only (_meta.file_b64)."`
- Same tightening on `file_path_a` / `file_path_b` (xlsx_diff) and
  `spec_path` (xlsx_write).
- **Sharpened `base_file_b64`** description to flag it as a NARROW
  EXCEPTION: "xlsx_write ONLY accepts a base64-encoded base
  workbook here for edit-in-place. Every OTHER tool in this
  connector takes a file PATH (`file_path`), not bytes."

All edits live in inputSchema property descriptions, which are NOT
subject to the 1024-char Desktop tool-description cap — the
hardening costs zero chars against the tool-level description
budget.

No functional behavior change. Verify by re-running the demo
prompt set unprompted (no explicit anti-base64 hand-steer) — the
model should call read/doctor/etc. directly with `file_path`
without inventing an encode step.

92/92 tests pass.

---

## [3.0.12] - 2026-06-07

Doc-class — register **xfa** as a documented alias so short prompts
("use xfa to read this file") route reliably to the connector. xfa
is already the internal brand surface (`xfa_*` API key prefix, `XFA_*`
env vars, `XFA_PRIVACY`, `XFA_WORKBOOK_CACHE_*`); this surfaces the
alias to the model so tool-selection signals match.

### Fixed

- `manifest.json.display_name`: `"xlsx-for-ai (xfa)"` — the alias
  appears in Claude Desktop's connector panel.
- `manifest.json.long_description`: opens with "(short name **xfa**)"
  so the alias is in the first sentence the model reads.
- `manifest.json.description`: notes "short name: xfa" alongside the
  product line.
- `manifest.json.keywords`: adds `"xfa"` for directory/search indexing.
- `mcp.js` `xlsx_read.description`: prepends `xfa — ` (6 chars). The
  workhorse tool (69% of all xfa traffic) now carries the alias in
  the description the model reads on every selection. Stays under
  the 1024-char Desktop cap (975 chars).
- README intro: adds an italic alias note up top.

Other tool descriptions left unchanged — the connector-level signal
(display name + long description) covers the routing flag for any
tool the model picks once it's in the xfa context, and the
xlsx_read prefix carries the workhorse case. Touching all 50 tool
descriptions would cost ~300 chars of catalog inflation without
adding meaningful selection signal.

No functional behavior change.

---

## [3.0.10] - 2026-06-07

Doc-only fix: `xlsx_read`'s description previously claimed it was "the
ONLY way to read .xlsx files on the user's local machine" — a sentence
from the local-stdio mental model that's wrong for hosted/remote MCP
deployments. The server in a remote deployment has no access to the
user's local filesystem; user-provided files must reach it via the
upload-handle flow (then `xlsx_read_handle`), not via `xlsx_read` with
a path.

### Fixed

- Rewrote `xlsx_read` description to be honest in BOTH deployment
  contexts: explicitly notes "the path resolves on the SERVER's
  filesystem," distinguishes local-CLI (server = user's machine) from
  remote/hosted (server = different host), and points remote-deployment
  callers at the upload-handle + `xlsx_read_handle` path for
  user-provided files.
- Stays under the 1024-char Claude Desktop cap (969 chars).

Surfaced via Bob's file-flow probe; SPM-flagged as low-pri but
worth fixing while fresh — first-day-friction for any new connector
user.

---

## [3.0.8] - 2026-06-06

Wild-adoption fix pair surfaced by a non-Bob Claude agent live-testing
the MCP. Both are pure friction-removal for callers who can't see our
server logs.

### Fixed

- **`xlsx_write` is now self-describing.** The `spec` param previously
  typed as bare `{type: 'object'}` with no shape. Agents guessed
  reasonable-but-wrong forms (top-level rows array, A1-keyed cells
  map). 3.0.8 declares the full nested shape (`{sheets: [{name,
  cells: [{address, value | formula}]}]}`) with property-level
  constraints (`address` regex, `value` vs `formula` mutual
  exclusivity, no-leading-`=` on formula). Tool description carries a
  minimal inline example so a single-shot read works without nested
  schema rendering.
- **4xx validation errors now surface inline.** `friendlyErrorMessage`
  previously had no `API_CLIENT_ERROR` case; the server's precise
  validation messages (`spec.sheets must be an array`,
  `cells[3].address is not a valid Excel address`) were computed,
  preserved by `lib/client.js`, then discarded at the MCP boundary in
  favor of the generic "see server-side logs" text. Callers without
  log access had no path forward.

  3.0.8 surfaces the structured server message (`payload.error.message`
  → `payload.message` → wrapped `err.message` with the
  `xlsx-for-ai API error 4xx:` prefix stripped) for the generic 4xx
  default. Specific HTTP statuses (429 rate-limit, 402 tier-upgrade)
  keep their pre-existing short friendly text. Bounded at 280 chars
  with an ellipsis to prevent pathological payloads.

### Security boundary preserved

- **5xx stays generic.** `API_SERVER_ERROR` returns the unchanged
  generic message — 5xx bodies can carry upstream internals. The new
  surfacing is 4xx-only.
- All pre-existing client-side codes (FILE_NOT_FOUND, DISALLOWED_EXTENSION,
  etc.) keep their dedicated short text and do NOT echo paths.

### Tests

- `test/v2/write-self-describing.test.js` — 3 tests pinning the
  inputSchema shape, the inline example, and the ≤1024 cap.
- `test/v2/friendly-error.test.js` — 11 tests covering the TEST_PLAN:
  structured 4xx, flat 4xx, empty 4xx, absent 4xx, prefix-strip
  fallback, **5xx-stays-generic discriminating case**, 429 / 402
  specific text, FILE_NOT_FOUND path-redaction, 280-char ellipsis,
  null/undefined-err graceful default.

---

## [3.0.7] - 2026-06-06

P1 mitigation + observability for the hosted-tool latency Bob saw in
Claude Desktop this morning. SPM measured 2 min 12 s round-trip for an
`xlsx_describe` call on a 2-row × 3-col file, with the SERVER processing
the request in 190 ms — the 2-minute gap was between client send and
server receive, in the dial / IPC layer.

3.0.7 doesn't pretend to root-cause that gap yet (the pattern fits an
IPv6-black-hole TCP-SYN retransmission timeline of ~127s, but it could
also be undici keep-alive socket churn or Claude Desktop's IPC queue;
the observability shipped here is the next-occurrence diagnostic).

### Changed

- **Per-attempt fetch timeout tightened from 30s to 15s** in `lib/client.js`.
  A stuck dial now fails fast instead of waiting half a minute.
- **Retry count bumped from 1 to 2 (3 attempts total, 45s ceiling).** Each
  retry opens a fresh socket after the prior AbortController fires, which
  breaks the stuck-keep-alive class of dial failures.

### Added

- **Structured stderr timing log per phase** of every tool call:
  - `send` — request prepared, body size recorded.
  - `response-headers` — server returned headers, attempt elapsed_ms.
  - `attempt-failed` — fetch threw, error name + code + attempt elapsed_ms.
  - `body-complete` — JSON body parsed, total elapsed_ms.
  - `all-attempts-failed` — all retries exhausted.

  Format: one-line JSON, `{"t":"xlsx-for-ai-mcp.timing", ...}`. Lands in
  `~/Library/Logs/Claude/mcp-server-xlsx-for-ai.log` automatically.
  Next time tool calls hang, SPM/Bob can grep that log and see which
  phase is slow.
- **`~` path expansion** in `mcp.js` `fileToB64`. Models often pass
  `~/Desktop/foo.xlsx`; Node's `fs.openSync` doesn't expand `~`, so the
  path ENOENT'd at the OS level. `~` and `~/...` are now expanded to
  the user's home dir before resolution. `~user/...` patterns pass
  through untouched (forward-only narrow).

### Tests

- `test/v2/client-timing.test.js` — asserts the stderr timing contract
  end-to-end via a subprocess against a local stub server. Catches a
  future refactor that drops the diagnostic signal. Also pins TIMEOUT_MS
  ≤ 15s and MAX_ATTEMPTS ≥ 3 at the source level so the SPM-tightened
  ceiling can't drift back.
- `test/v2/tilde-expansion.test.js` — 6 tests on `expandTilde`: bare
  `~`, `~/` prefix, mid-string `~` ignored, `~user/` ignored, non-string
  / empty input tolerated.

---

## [3.0.5] - 2026-06-05

Hotfix: client-side `lib/annotations.js` was missing entries for 8 of the
50 tools — Claude Desktop's permission panel rendered them as bare names
("Other tools 8 by raw name") instead of titled / bucketed rows.

The 8 are: `xlsx_healer_diagnose`, `xlsx_healer_simulate`,
`xlsx_healer_cure`, `xlsx_healer_intent`, `xlsx_receipt`,
`xlsx_verify_receipt`, `xlsx_read_handle`, and
`xlsx_session_set_validations`. They've existed in the MCP surface for
some time; the annotation map was never updated alongside.

The server-side annotation theme will eventually be the single source
of truth (emits annotations on `/api/v1/tools/list`), but the npm
client's baked map is the floor until that ships and deploys. Bringing
the floor up to parity here.

### Added

- 8 missing entries in `TOOL_ANNOTATIONS`: 4 read-only (healer_diagnose,
  healer_simulate, verify_receipt, read_handle), 3 Save-As writes
  (healer_cure, healer_intent, receipt), 1 stateful-session write
  (session_set_validations).
- `test/v2/annotations-completeness.test.js` pins the parity invariant:
  every tool in the `TOOLS` array must have a matching `TOOL_ANNOTATIONS`
  entry, and every emitted tool must have `annotations.title` plus a
  boolean `annotations.readOnlyHint`. The next tool added to TOOLS
  without an annotation entry fails the test before publish.

---

## [3.0.3] - 2026-06-05

Hotfix: Claude Desktop silently drops tools whose `description` exceeds
an undocumented per-tool length cap (~1200 chars in the protocol Bob's
client speaks today). Bob installed 3.0.2 clean — schemas were correct,
50/50 tools registered — but the Tool permissions panel showed only 43,
and the 7 missing tools included flagship surfaces (xlsx_stamp,
xlsx_receipt, xlsx_doctor, xlsx_data_clean).

The MCP TypeScript SDK has no documented cap on `Tool.description`
(verified — `z.string().optional()`, no `.max()`), and Anthropic's
public docs don't surface one either. The ~1200 cliff is a Claude
Desktop client-side enforcement.

### Fixed

- **20 over-budget descriptions trimmed to ≤1024 chars.** Budget set
  at 1024 (round binary, 18% safety margin under the observed cliff).
  7 actively-dropped tools (xlsx_data_clean, xlsx_doctor,
  xlsx_workbook_views, xlsx_stamp, xlsx_receipt, xlsx_properties,
  xlsx_pivot_tables) + 13 in the 1024-1200 danger zone (defensive
  against a future Desktop cap tightening).
- **Bulk-removed the "xlsx-for-ai — read, write, diff, redact,
  supervise .xlsx files locally." brand boilerplate** from every tool
  description. The prefix added ~74 chars × 50 tools = ~3.7 KB of
  catalog noise without steering the model toward any tool. The
  load-bearing signal is the USE WHEN / DO NOT USE WHEN clauses + the
  LOCAL filesystem hint.
- **Compressed competitive framing** ("No other tool does this", "vs.
  pandas") from the over-budget tools. The model's tool-selection
  decision keys off Use-when, not vs-competitor framing.

### Tests

`test/v2/description-length.test.js` pins the 1024-char invariant —
any TOOLS entry whose description exceeds the budget fails the test,
with the budget-violator names listed in the failure message. Catches
regressions before publish.

`test/v2/api.test.js` updated: dropped the obsolete assertion that
every description must start with `xlsx-for-ai —` (the brand prefix
was removed). USE WHEN / DO NOT USE / LOCAL filesystem assertions
preserved as the load-bearing checks.

---

## [3.0.1] - 2026-06-05

Hotfix release. Two coupled defects in 3.0.0 made `.mcpb` install
unusable in Claude Desktop:

1. **`initialize` blocked on the network.** Under Claude Desktop's
   bundled Node 24.15.0 runtime, `mcp.js` blocked `initialize` on the
   first-run registration POST and the dynamic tool-catalog GET; the
   dial would stall (IPv6 / Happy-Eyeballs edge inside Electron), the
   client's 60s timeout fired, and the MCP attach died before
   `tools/list` was ever called. The same bundle worked under system
   Node 25.6.1 because the dial resolved instantly.

2. **`tools/list` shipped without `inputSchema`/`description`.** The
   hosted `/api/v1/tools/list` returns minimal stubs
   (`{name, category, maturity_state, endpoint}`), and the
   client's `mergeTools` was letting those stubs *replace* the
   bundled-catalog full schemas on every name collision. Claude
   Desktop receives a tools/list whose entries have no `inputSchema`
   and silently drops the entire array — tool permissions panel
   empty, no `tools/call` ever fires, even after reinstall / connector
   toggle / restart. Server-side defect mirrored client-side; this
   release fixes the client floor so the bundled schemas survive.

### Fixed

- **`initialize` is now decoupled from the network.** The MCP transport
  connects first and serves the bundled tool catalog (48 tools) as the
  floor. Registration + dynamic catalog upgrade run in the background
  after `connect`. The client sees `initialize` respond in milliseconds
  regardless of network state.
- **`tools/list_changed` notification.** When the background upgrade
  swaps in the live catalog (typically 50 tools), the server emits
  `notifications/tools/list_changed` so the client refreshes its tool
  inventory. The server now declares `capabilities.tools.listChanged`.
- **Bounded background timeouts.** Registration: 10s. Catalog: 8s. If
  either hangs, it's logged to stderr and the process keeps running on
  the bundled catalog. The bundled set already covers every tool the
  user reaches in normal flows; the upgrade is additive.
- **EPIPE on background writes.** If a client disconnects while the
  catalog upgrade is in flight, `sendToolListChanged()` writes to a
  closed pipe and Node raises EPIPE asynchronously on the Socket. The
  process now exits 0 cleanly instead of crashing with an unhandled
  Socket `'error'` event.

- **`mergeTools` is now a field-level merge.** Remote tools win on every
  field they actually provide; baked-in fields (`description`,
  `inputSchema`) fill in the gaps. This preserves the MCP-spec fields
  the hosted catalog currently omits.
- **`sanitizeForMcp` floor in `lib/annotations.js`.** A safety net: any
  tool that reaches the MCP transport without `inputSchema` gets the
  permissive `{ type: 'object' }` floor; any tool without a `description`
  gets the annotation title (or a generic `xlsx-for-ai tool: <name>`).
  This guarantees registration even when the catalog returns a stub
  the bundled `TOOLS` array can't shape — but the floor is a *diagnostic*,
  not the ship target.
- **Real per-tool `inputSchema` for the 2 previously server-only tools.**
  `xlsx_read_handle` and `xlsx_session_set_validations` are now in the
  bundled `TOOLS` array with full `inputSchema` (properties + required)
  mirroring the server-side route validation. Dispatch handlers added
  in `dispatchTool` so the calls relay correctly (`workbook_handle` for
  read-handle, `session_id + validations` for the session tool — neither
  fits the generic file_b64 relay path). All 50 tools now ship with
  real per-tool schemas; zero fall through to the sanitize floor.

### Tests

`test/v2/mcp-initialize.test.js` pins the invariants end-to-end:

- `initialize` responds in <2s even when `XLSX_FOR_AI_API` points at a
  TCP black hole (RFC 5737 TEST-NET-1).
- `tools/list` serves the bundled catalog (≥40 tools, all with name +
  inputSchema + non-empty description) before any network upgrade lands.
- Upgrade path: a stub server returning only `{name, category,
  maturity_state, endpoint}` produces a sanitized tools/list where
  every entry has `inputSchema` and `description`; the overlap with
  the bundled catalog keeps the full bundled schema; tools/list_changed
  fires on the wire.

`test/v2/annotations.test.js` adds 7 unit tests for `sanitizeForMcp`.

`test/v2/discover.test.js` pins the field-level merge: when remote
omits `inputSchema`/`description`, baked fills them; when remote
provides any field, remote wins on it.

### Docs

- Bundled tool count rises from 48 → 50 (added `xlsx_read_handle`
  + `xlsx_session_set_validations` per the tightening above).
- README tool count corrected to 50 (intro, "What it does" header,
  Claude Desktop verify line, Cursor verify line, Codex CLI verify line).
- New Healer section documents the 4-tool family (`xlsx_healer_diagnose`,
  `xlsx_healer_simulate`, `xlsx_healer_cure`, `xlsx_healer_intent`) —
  external-reference breakage repair, the biggest documentation gap.
- Read/write section adds `xlsx_data_clean`, `xlsx_read_handle`, and
  `xlsx_session_set_validations` (previously undocumented in the README
  even though all three are live in the hosted catalog).
- Free-tier read-only count corrected to 39 (was 36; `xlsx_validate`
  remains the lone Free-excluded read-only tool, requires Bronze+).
- Removed the 2.25.0–2.26.0 crash banner — the deprecate workflow
  surfaces it at `npm install` time, and it's confusing to a fresh
  3.0.x reader.

---

## [3.0.0] - 2026-06-05

The "whole new world" consolidation cut. Bob's call: the 2.x→now delta
(hosted server platform, 7-theme production-hardening, healer-deep,
Stamp+Receipt, MCP tool annotations, prepublish allowlist guard, npm
deprecation channel) is big enough that a major bump tells users
"this is a different product than where you joined." 3.0.0 is that
line.

### Added

**Healer family exposed via MCP — 4 tools.**
The healer-deep server build (4 routes deployed since 2026-06-04) was
invisible to MCP-aware clients until now. Adds `xlsx_healer_diagnose`,
`xlsx_healer_cure`, `xlsx_healer_simulate`, and `xlsx_healer_intent` to
the npm client `mcp.js` TOOLS array + dispatch handlers.

- `xlsx_healer_diagnose` — structured report of external-ref breakage
  (broken refs, defined-name external refs, PQ connections with embedded
  credentials, `#REF!` propagation maps, multi-hop chains). Read-only.
- `xlsx_healer_cure` — apply ONE specific cure operation
  (rename_move / pattern_bulk / source_deleted_freeze / redirect /
  localize / permission_denied / structure_changed / format_change /
  make_standalone, plus v1.1 chain_collapse + modernize_to_pq).
  Returns cured bytes + per-operation receipt.
- `xlsx_healer_simulate` — recipient-side accessibility check. Given
  paths the recipient CAN see, returns which refs will resolve and which
  will break. Read-only — no output workbook.
- `xlsx_healer_intent` — goal-driven healing. Declare an intent
  (`make-it-work` / `make-standalone` / `migrate`) and Healer plans the
  operation sequence + applies it. Returns planned ops + cured bytes +
  unactionable list. `migrate` requires `from`/`to` prefix params;
  `in_place` mode requires `confirm: true`.

**CLI `heal` intent path (completes the subcommand).**
`xlsx-for-ai heal <file> --intent <make-it-work|make-standalone|migrate>`
+ `--from <prefix>` + `--to <prefix>` + `--confirm` (required for
`--mode in_place`). The previous version of the CLI rejected
`--intent`/`--from`/`--to` with a "reserved for v1.1" stub since the
server route wasn't live; the route has been shipping since
2026-06-04. Goes alongside the existing diagnose-only and
`--operation` paths (now mutually exclusive — pick one).

### Changed

**Tool count: 48** (was 44 at 2.26.x). README counts updated everywhere
they appear. Categories: 1 capstone (xlsx_doctor), the read/write/
analysis/inspection cluster, 2 integrations (Slack + Teams), and the
new 8-tool integrity surface (Stamp + Verify Stamp + Receipt + Verify
Receipt + 4 Healer).

**Canonical MCP install: `npx -y -p xlsx-for-ai@latest xlsx-for-ai-mcp`.**
Self-heals across npm releases on every MCP client restart — no
manual `npm install -g` needed when a new version ships. The 6 README
client snippets (Claude Desktop / Cursor / Continue / Codex CLI /
Zed / Windsurf) all use this form. Global install is kept as the
offline-friendly alternative.

### Server-side (was already deployed before 3.0.0)

- `xlsx_receipt` + `xlsx_verify_receipt` added to the server's
  `tools-list.ts` inventory (they were already shipping as routes +
  npm-client tools — this closes the manifest-drift gap so
  `GET /api/v1/tools` reports the actual shipped surface).

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
