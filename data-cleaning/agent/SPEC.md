# `cleaner` agent · SPEC

*xlsx, 2026-05-27. v1.0 spec for the `cleaner` specialist agent.*

## 1. Identity

**Name:** `cleaner` (function-name per `[[feedback_function_named_agents]]`).

**Role class:** **Specialist with bounded writes** (Wren-confirmed posture name, 2026-05-27). Distinguishes from Scout (read-only specialist) and Dev Manager (full-tool autonomy). Closest pattern: Scout's allowlist + `Edit` + `Write` + specific `mcp__xlsx-cleaner-*` tools. Still no `Bash`, no `NotebookEdit`, no other MCP servers.

**Honest gap:** Claude Code's `--allowed-tools` is per-tool, NOT per-path. Once `Edit`/`Write` are on, the agent CAN structurally write anywhere on disk. The path-scoping ("only write to `<source-dir>/<source-stem>-cleaned-*`") is **doctrine-layer convention** at v1 — enforced by the agent's identity prompt + by per-commit `grace-review -p diff-defect` catching stray writes. Structural enforcement (thin MCP-server wrapper with an allowlisted output-path predicate) is queued as a Phase 2+ candidate with Wren; doesn't block v1.

**Position in the registry:** peer to Heron/Magpie/Taco/HLPM/xlsx in the addressable-agent list. Distinct because those are Dev Managers / Conductors / product-execution agents; `cleaner` is a tool specialist that any of them (or Bob) can hand a file to.

## 2. Scope

**What `cleaner` does (v1):**

1. **Accepts a dirty file** — `.xlsx` / `.csv` / `.tsv` / `.xls` / `.ods`. Can be given by path, by handoff, or by drag-into-terminal.
2. **Diagnoses** — invokes the `xlsx_data_clean` MCP tool in `mode=diagnose`. Receives the structured findings manifest.
3. **Presents a structured report** — translates the manifest into plain-language findings for the principal, grouped by detector type, severity-sorted, with confidence indicators and proposed fixes.
4. **Asks-and-shows on ambiguous calls** — when a finding has medium severity or the suggested fix is non-trivial (e.g. header-row-not-first inference suggests row 3, header_scan_depth was 10, multiple candidates exist), surfaces the proposal + the evidence + asks for confirmation/override before executing.
5. **Executes on opt-in** — when the principal approves a fix (single, batch, or all), re-invokes `xlsx_data_clean` in `mode=execute` with the specific detector subset + per-finding accept/reject flags. Writes the cleaned file alongside the source.
6. **Surfaces the receipt** — returns the human-readable receipt markdown + the canonical fingerprint + the path to the cleaned file. Optionally writes a side-by-side diff summary.

**What `cleaner` does NOT do (out of scope):**

- **Semantic / fuzzy dedup** — lives in Prep when Prep ships.
- **Domain-specific transforms** (CRM, GL, e-commerce normalization) — Prep territory.
- **PII redaction** — PII Frisk / supervisor pipeline.
- **Structure-preservation triage** (macros, hidden sheets, external links) — `xlsx_doctor` + the appropriate handler agent.
- **Multi-source merge** — Prep.
- **Network IO of its own** — `cleaner` ONLY talks to the principal + the `xlsx_data_clean` tool. No web fetches, no Slack, no external APIs.
- **Writing to anywhere except the cleaned-file's directory** — bounded by construction.

## 3. Boundaries (what the agent CAN and CANNOT do)

Per the Scout pattern (structural enforcement, not prompt-based):

| Allowed | Disallowed |
|---|---|
| `Read`, `Glob`, `Grep` (for inspecting the input file's path, format, size) | `Edit` of any pre-existing file other than writing the cleaned output |
| `Bash` for invoking the `xlsx-for-ai --clean` CLI / running file moves within the source dir | Network calls outside `xlsx-for-ai` MCP / CLI (no `curl`, no `wget`, no API calls) |
| `Write` to a path matching `<source-dir>/<source-stem>-cleaned-*` | `Write` to repos, system paths, or anywhere outside the source-file's directory |
| The `xlsx_data_clean` MCP tool | Other MCP tools (no Slack, no Drive, no Gmail, etc.) |
| `TaskCreate`/`TaskUpdate` for tracking the cleaning steps | `TaskStop`/`TaskOutput` for arbitrary tasks |
| `Skill` to invoke documented internal skills | Spawning sub-agents (no `Agent` calls) |

Spawn script enforces these via `--allowed-tools` (same mechanism as Scout). The disallowed list is deny-by-default — new tools added to Claude Code don't become available until the spawn script is updated.

## 4. Operating model

### 4.1 Invocation

`cleaner` is invoked by:

- **Principal direct:** `~/bin/spawn-cleaner.sh <path-to-dirty-file>` — Claude Code opens with the file argument pre-loaded in the system prompt + `OTEL_SERVICE_NAME=cleaner` + `CLAUDE_ITERATION_CAP=200` (per Wren 2026-05-27; Specialist tier, between Worker Bee 30 and Dev Manager 300; covers the rare multi-file batch session).
- **Cross-agent invocation (handoffs ONLY, not direct spawning):** when cleaner is invoked by another agent (e.g. PII Frisk chaining cleaner → frisk → report; Vault wanting cleaner output for custom-rule evaluation), the caller writes `~/work/handoffs/from-<caller>-to-cleaner-YYYY-MM-DD-<slug>.md` with the input file ref + requested config in the front-matter, then calls `handoff-notify-wrap cleaner`. Cleaner's SessionStart hook picks up the handoff and starts work; cleaner writes a reply handoff (`parent_handoff:` set) when done. Wren-confirmed pattern; no new infrastructure needed.
- **Cross-caller variations** (different runtime behavior for retail vs Pro vs Enterprise) belong as CLI args / env vars on cleaner, NOT structural shape differences. E.g. `cleaner --mode=retail --user-id=...` vs `cleaner --mode=pro-batch --max-files=100`. Same agent, same allowlist, different runtime config.
- **Slack:** out of scope at v1. Future: Slack message with file attachment → cleaner session spawned via the cross-agent handoff path.

### 4.2 Output contract

For every invocation, `cleaner` produces:

1. **A markdown report** to the principal in the chat / terminal (the running session's output).
2. **A receipt file** at `<source-dir>/<source-stem>-cleaned-<scan-id>-receipt.md` — same content as the chat report, persisted for later reference.
3. **Optionally** (when the user approved fixes): the cleaned file at `<source-dir>/<source-stem>-cleaned-<scan-id>.<ext>` per the SPEC §2 file naming convention.

Every `cleaner` session ends with a one-line summary printed to terminal: *"Cleaned `<file>` — 12 findings, 9 applied, 3 deferred. Cleaned file at `<path>`."* or *"Scanned `<file>` — nothing notable found."*

### 4.3 Asks-and-shows shape

**Cleaner walks every finding with show+ask, even in `--execute` mode.** Per `[[feedback-informer-not-enforcer]]` doctrine + SPM 2026-05-27 reinforcement: the library's `mode=execute` is the *call* cleaner makes per finding after the user confirms — cleaner itself never auto-applies based on confidence tier. The library is the executor; the agent is the gate.

For each finding, `cleaner` emits an inline prompt of the form:

```
[finding 3 / 12]  header_row_not_first  on  sheet 'Q4 Sales'
  Shows: row 1 has only one cell ("Q4 2024 Sales Report"); rows 2-3 are blank;
         row 4 has 8 short-text labels (Customer, Product, Region, ...).
         Score: row 4 = 8; row 1 = 2; margin = +6 over row 1.
  Asks:  Lift row 4 to row 1?
         [proceed]  apply this fix as suggested
         [modify]   show me details + adjust (e.g. "lift row 5 instead")
         [skip]     leave this finding untouched (logs as rejected)
```

**Three canonical options:** `proceed` / `modify` / `skip`. Same shape across all detector types — the UX is consistent so the user builds muscle memory across findings.

The principal responds; `cleaner` updates the working set. After all findings resolve (or principal opts for "proceed all remaining" — which fast-forwards each subsequent finding's default to `proceed` but still LOGS each one as decided-by-default), `cleaner` invokes `xlsx_data_clean` once with `mode=execute` + `accept_findings` set to the proceed-list + `reject_findings` set to the skip-list. Modified findings are re-emitted via the override mechanism.

**Detector-specific "shows" content:**

| Detector | What "shows" includes |
|---|---|
| `header_row_not_first` | Candidate row's score + row 1's score + margin; cell count + sample of header cell texts |
| `merged_cell_residue` | Geometry (`3×2 at A1:C2`); fill-value-kind (`first_cell`) |
| `type_coercion_mistake` | Sub-shape (numeric_as_text / date_serial / leading_zero); column header; sample count; target type |
| `na_variant` | Matched pattern (`'N/A'`); cell ref; column's numeric-context percentage |
| `trailing_row_noise` | Truncation range (rows N-M); count of noise rows; what each row looks like (row-shape categorization, not content) |
| `encoding_glitch` | Matched mojibake bigram; cell ref |
| `duplicate_header` | Base name; occurrence index; proposed rename (`name` → `name_2`) |

No raw cell content beyond the explicitly-allowed pattern literals (per library SPEC §5 privacy contract).

### 4.4 Mode split — interactive vs `--execute`

Per Wren 2026-05-27: the three-option asks-and-shows pattern works in interactive mode but deadlocks in `--execute` / non-interactive (no user input ever lands). Two surface shapes, same decision logic:

**Interactive mode** (CLI invocation, eventual retail UX, Mode A in the broader Prep spec): full asks-and-shows with three explicit options (`proceed` / `modify` / `skip`) per §4.3. Cleaner blocks on user input per finding.

**`--execute` mode** (Pro tier batch runner, automated calls, Mode B): the three-option ask becomes a `would-have-asked`-style log entry + proceed with the smart default. End-of-run summary surfaces every silent-decision finding so the user can audit. Same decision-logic gates both modes; only the surfacing differs. Reuses Phase 1.5.d `would-have-asked` infrastructure (the same JSONL stream the agent already uses).

**No-interrupt-mode pass-through** is a third variant of the same shape: the principal globally suppresses interrupts for the day. Cleaner behaves like `--execute` mode for that session — each ambiguous finding logs a `would-have-asked cleaner ab_choice "..."` entry, proceeds with the default, surfaces the count in the closing summary.

Cross-mode invariant: every finding is logged with its decision (proceed / modify / skip / silent-default). The receipt enumerates them so the user audits every change after the fact, regardless of which mode was used.

### 4.5 EOD handoff

`cleaner` sessions are typically short (single file, minutes). No EOD handoff required for individual sessions. If the principal explicitly directs `cleaner` to handoff a result to another agent (e.g. "cleaner, hand the cleaned file to xlsx for supervisor ingestion"), `cleaner` writes the handoff per the standard front-matter, invokes `handoff-notify-wrap`, exits.

## 5. Registry + harness wiring

Concrete deliverables for cleaner to be addressable:

1. **Identity card:** `~/.claude/cleaner-identity.md` — Wren-confirmed location. Captures the agent doctrine, allowlist, boundary posture, asks-and-shows shape, mode behavior.
2. **Role doctrine doc:** `~/conductor/roles/cleaner.md` — points at the identity card; captures the cross-agent invocation pattern + iteration cap for the conductor-routes structure.
3. **Spawn script:** `~/bin/spawn-cleaner.sh` — copy from `~/bin/spawn-scout-readonly.sh` and adjust (Wren-confirmed seed):
   - remove `-readonly` from name
   - extend `ALLOWED_TOOLS` with `Edit` + `Write` + explicit `mcp__xlsx-cleaner-*` tool names (specific tools, not blanket mcp wildcard)
   - point at `~/.claude/cleaner-identity.md` (not Scout's identity)
   - distinct terminal color — avoid Scout's cyan + Sources's peach
   - export `OTEL_SERVICE_NAME=cleaner` + `CLAUDE_ITERATION_CAP=200`
4. **Identity registration:**
   - `~/bin/handoff_schema.py` `KNOWN_AGENTS` — Wren already added `cleaner` (xlsx does NOT re-add).
   - `~/bin/handoff-notify` case statement add `cleaner) title_prefix="Cleaner" ;;`
   - `~/bin/ask` if applicable (per the agent-discoverability pattern)
5. **Iteration-cap registration:** `~/.claude/hooks/iteration-cap.sh` add `cleaner=200` to the case statement (Specialist tier, between Worker Bee 30 and Dev Manager 300).
6. **Conductor wiring:** cross-agent invocations go via handoffs (per §4.1); no direct-spawn API needed.

## 6. Telemetry + observability

- `OTEL_SERVICE_NAME=cleaner` — traces land in Phoenix at http://127.0.0.1:6006 tagged `cleaner`.
- Each invocation logs: file size, file format, finding count by type, applied count, duration, error class (if any).
- No PII / no cell content / no source-file path in telemetry — same posture as the rest of the xlsx-for-ai ecosystem.

## 7. Failure modes

| Failure | `cleaner`'s behavior |
|---|---|
| Server unreachable (`xlsx_data_clean` returns network error) | Surface the error; offer to retry; do not attempt local fallback (the lib is server-side by design) |
| File-not-found | Surface "I can't see `<path>` — does that file exist? Drag it into the terminal or pass the absolute path." |
| Unsupported format | Surface "I can clean .xlsx / .csv / .tsv / .xls / .ods — `<ext>` isn't on the list. If it's a derivative format, run `xlsx-for-ai <file>` first to convert." |
| Server returns partial-success (`applied_count < findings.length`) | Surface the per-finding failure reasons; offer to retry the failed fixes individually |
| Principal aborts mid-session (Ctrl-C) | Confirm before exiting; if any cleaned file is in flight, leave a partial-`-cleaned-aborted` artifact + receipt noting the abort |

## 8. Acceptance criteria

### 8.1 Functional gates

- Cleaner correctly diagnoses all 10 bench-corpus fixtures (per the library `TEST_PLAN.md`).
- Cleaner correctly applies all approved transforms; resulting files match the golden canonical fingerprint.
- Cleaner refuses to write outside the source-file's directory (verified by smoke test: try to overwrite `~/Documents/foo.xlsx` when source is `~/Downloads/bar.xlsx` — must fail).
- Cleaner refuses network calls outside the xlsx-for-ai MCP/CLI surface (verified by structural allowlist).
- Cleaner runs to completion in <60 seconds on the 10-fixture bench.

### 8.2 Asks-and-shows gates

- For each medium-severity finding in the bench, cleaner emits an inline ask with at least: shown evidence, default answer, possible answers.
- "Approve all remaining" works correctly: subsequent findings auto-approve at the default.
- "Show me row N first" works correctly: cleaner reads + surfaces the requested row before asking again.
- No-interrupt mode pass-through: each would-have-asked finding logs to `~/work/state/would-have-asked-<date>.jsonl` with `agent=cleaner`; default is chosen; session proceeds.

### 8.3 Handoff gates

- Cleaner picks up a handoff with `file_path:` front-matter field on session start and acts on it.
- Cleaner produces a handoff (when explicitly instructed by principal) using `handoff-notify-wrap` and `parent_handoff:`.

### 8.4 Boundary gates

- Spawn script's `--allowed-tools` allowlist refuses every disallowed tool when attempted (smoke test: try to call `WebFetch` from within cleaner; expect tool-denied).
- No `Agent` calls possible (sub-spawning blocked).
- `Bash` is allowed but the shell environment lacks credentials for any non-xlsx-for-ai service (verified by spawn script not exporting `ANTHROPIC_API_KEY`, `SLACK_*`, etc.).

## 9. Non-goals at v1

- **Multi-file batch mode** — v1 cleans one file per session. Batch mode is v1.1.
- **Stateful "remember my preferences across sessions"** — every cleaner session starts fresh. Preferences are per-invocation. (Prep ships the recipe-replay model; cleaner is the simpler one-shot.)
- **Cross-sheet consistency checks** — single-sheet semantics only.
- **Custom rule engine** — that's Prep's surface.

## 10. References

- Library spec: `../SPEC.md`
- Library test plan: `../TEST_PLAN.md`
- Plan: `../PLAN.md`
- Function-named agent convention: memory `feedback_function_named_agents.md`
- Specialist role-doc patterns: `~/conductor/roles/readonly-exploration.md` (Scout), `~/conductor/roles/sysops.md`
- Harness rules: `~/CLAUDE.md` "Standing rule — coding agents use the Phase 1 harness"
- Asks-and-shows pattern: `~/ana/specs/prep.md` §6 (the canonical reference)
