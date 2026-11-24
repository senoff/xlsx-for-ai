# xlsx-for-ai

[![xlsx-for-ai MCP server](https://glama.ai/mcp/servers/senoff/xlsx-for-ai/badges/score.svg)](https://glama.ai/mcp/servers/senoff/xlsx-for-ai)

*Short name: **xfa** — a real CLI command (`xfa <file>`, `xfa samples`, `xfa --version`) and the prompt shorthand (e.g. "use xfa to read this file"). Same entrypoint as `xlsx-for-ai`; matches the internal `xfa_*` / `XFA_*` brand surface.*

**Verified values, preserved structure, up to 100MB**

The missing reliability layer for spreadsheet work in LLM agents. Read, write, diff, validate, and analyze .xlsx files end-to-end — with merged cells, formulas, named ranges, conditional formatting, pivots, and charts preserved.

xlsx-for-ai makes Claude reliable on real-world Excel files. Seventy-plus tools cover the structural surface that pandas-style sandboxes drop on the floor: merged cells, named ranges, formulas with results, conditional formatting, pivots, slicers, charts, comments, data validations, hyperlinks, cross-sheet topology, external links, form controls, VBA macros, document properties, and protection settings. A soundness check (`xlsx_validate`) flags corruption other readers silently mask. A hosted recalc engine computes served values in-house — no third-party formula engine in the serve path.

**In Claude Code, one command:**

```bash
claude plugin install xlsx-for-ai --marketplace senoff/xlsx-for-ai
```

Then run `/reload-plugins` (or restart Claude Code), open `/mcp`, choose `plugin:xlsx-for-ai:spreadsheets` and sign in once. Needs Claude Code 2.1.292 or later (`claude update` if yours is older). More on the plugin is under [Claude Code plugin](#claude-code-plugin) below.

**In the Claude app (claude.ai):** find xlsx-for-ai in the connector directory at [claude.ai/directory](https://claude.ai/directory) and click Connect.

**The npm package** (Claude Code, Cursor, Claude Desktop and others):

```bash
npm install -g xlsx-for-ai
```

The global install puts the `xlsx-for-ai-mcp` binary on your PATH — that's what the canonical configs below point at. A pinned global install launches fast (it still needs an internet connection, because the files are read by the hosted service); upgrade with `npm install -g xlsx-for-ai@latest` when a new version ships.

> **Upgrading from 1.5.x?** This is a re-architecture, not a feature bump: the heavy local engine is gone from the npm package. All rendering happens server-side. The `cursor-reads-xlsx` alias still works. See [Migration](#migration-from-15x) below.

---

## MCP configuration

Add the server to your agent runtime under the name **`xfa`** (so "use xfa to read this" resolves). First run needs a one-time sign-in. In an editor or desktop app, your first request answers with a sign-in link and a short code: open the link, approve, then ask again. Or run `xlsx-for-ai login` in a terminal first (see [First-run sign-in](#first-run-sign-in)). Keys created by older versions keep working for now. When that changes, the sign-in link appears in the same place, so there is nothing to do ahead of time.

There are two ways in:

- **Local package.** The app starts `xlsx-for-ai-mcp` on your computer (stdio). Install it once with `npm install -g xlsx-for-ai`. No key to paste: the first request gives a sign-in link and code. It can read files on your computer by path. If you would rather not install globally, use the command `npx` with the arguments `-y -p xlsx-for-ai xlsx-for-ai-mcp` wherever a section below says `xlsx-for-ai-mcp`.
- **Hosted with sign-in.** The app connects to `https://api.xlsx-for-ai.dev/mcp` over HTTP and signs you in in the browser (OAuth). Nothing to install. It cannot read files on your computer: give it a link to the file (shared as "anyone with the link can view") or use the upload link it offers.

| App | Local package | Hosted with sign-in | Steps |
| --- | --- | --- | --- |
| Claude Code | yes | yes | [Claude Code](#claude-code) |
| Claude Desktop | yes | yes | [Claude Desktop](#claude-desktop) |
| Cursor | yes | yes | [Cursor](#cursor) |
| Continue | yes | no | [Continue](#continue) |
| Codex CLI | yes | yes | [Codex CLI](#codex-cli) |
| Gemini CLI | yes | yes | [Gemini CLI](#gemini-cli) |
| ChatGPT and other remote connectors | no | yes | [ChatGPT](#chatgpt-and-other-assistants-with-remote-connectors) |
| Zed | yes | yes | [Zed](#zed) |
| Windsurf (now Devin Desktop) | yes | yes | [Windsurf](#windsurf) |
| Cline | yes | no | [Cline](#cline) |
| VS Code with GitHub Copilot | yes | yes | [VS Code](#vs-code-with-github-copilot) |
| Roo Code | yes | no | [Roo Code](#roo-code) |
| Qoder | yes | no | [Qoder](#qoder) |
| JetBrains AI Assistant | yes | no | [JetBrains AI Assistant](#jetbrains-ai-assistant) |
| Junie | yes | yes (Junie CLI) | [Junie](#junie) |
| Amazon Q Developer CLI | yes | yes | [Amazon Q Developer CLI](#amazon-q-developer-cli) |
| Goose | yes | yes | [Goose](#goose) |
| opencode | yes | yes | [opencode](#opencode) |
| LM Studio | yes | no | [LM Studio](#lm-studio) |
| Kiro | yes | yes | [Kiro](#kiro) |
| Warp | yes | yes | [Warp](#warp) |
| Anything else | yes | if it supports remote servers with OAuth | [Any other MCP client](#any-other-mcp-client) |

"No" means the app's docs do not describe signing in to a remote server from its main settings; use the local package there.

### Claude Code

The global install auto-registers the `xfa` MCP server in `~/.claude.json` — no extra step:

```bash
npm install -g xlsx-for-ai
```

If your environment skips install scripts (`--ignore-scripts`, CI, or a sudo install), register it manually:

```bash
claude mcp add --scope user xfa -- xlsx-for-ai-mcp
```

Hosted instead (or use the [Claude Code plugin](#claude-code-plugin), which sets this up for you):

```bash
claude mcp add --scope user --transport http xfa https://api.xlsx-for-ai.dev/mcp
```

then run `/mcp` in Claude Code, choose `xfa` and sign in in the browser.

Verify: `claude mcp list` shows `xfa` as connected (the hosted one shows "Needs authentication" until you sign in). In a new session, ask "what MCP tools do you have?" and check that the `xlsx_*` tools are listed, including `xlsx_doctor` (one-call health report — try it first on any unknown workbook).

Then run `xfa samples` (shorthand for `xlsx-for-ai samples`) to drop two demo workbooks in your working directory and get paste-ready prompts to try.

### Claude Desktop

Claude Desktop reads files, but it cannot recalculate formulas, read a very large workbook exactly, or hand back a real `.xlsx`. The `xfa` server adds those. The install does not touch Claude Desktop, so add the server yourself. Install the package first (`npm install -g xlsx-for-ai`), then open the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

(In Claude Desktop: Settings → Developer → Edit Config opens it.) Add `xfa` under `mcpServers`, keeping any servers already there:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Fully quit and reopen Claude Desktop. Verify: click "Add files, connectors, and more" (bottom left of the message box), then Connectors → Manage connectors, choose `xfa` and check that the `xlsx_*` tools are listed. Your first request answers with a sign-in link and a short code: open the link, approve, then ask again.

Hosted instead: Customize → Connectors → **+ Add** → Add custom connector, name it `xfa`, enter `https://api.xlsx-for-ai.dev/mcp`, and sign in when asked. Free plans allow one custom connector.

### Cursor

Config file: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project.

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Hosted instead: use `"url": "https://api.xlsx-for-ai.dev/mcp"` in place of `"command"`. Cursor signs you in when the server asks.

Verify: open Customize in the sidebar, check that `xfa` is on and the `xlsx_*` tools are listed under Available Tools. If it does not connect, open the Output panel and choose "MCP Logs".

### Continue

Continue now uses YAML config (`config.json` is deprecated). Create `.continue/mcpServers/xfa.yaml` at the top of your workspace:

```yaml
name: xfa
version: 0.0.1
schema: v1
mcpServers:
  - name: xfa
    type: stdio
    command: xlsx-for-ai-mcp
```

Or add the same `- name: xfa` entry under `mcpServers` in your existing Continue config. A JSON file in the Claude Desktop / Cursor format placed in `.continue/mcpServers/` also works.

Verify: MCP tools work only in Continue's **agent** mode. Switch to agent mode, ask "what tools do you have?" and check that the `xlsx_*` tools are listed.

### Codex CLI

Codex reads `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project). Add it with one command:

```bash
codex mcp add xfa -- xlsx-for-ai-mcp
```

which writes this table (you can also add it by hand):

```toml
[mcp_servers.xfa]
command = "xlsx-for-ai-mcp"
```

Hosted instead:

```toml
[mcp_servers.xfa]
url = "https://api.xlsx-for-ai.dev/mcp"
```

then run `codex mcp login xfa` and sign in in the browser (`codex mcp add xfa --url https://api.xlsx-for-ai.dev/mcp` adds the table and starts the sign-in straight away). Without a browser on that machine, use `codex mcp login xfa --no-browser`.

Verify: `codex mcp list` shows `xfa` as enabled. In a Codex session, run `/mcp` and check that `xfa` and its `xlsx_*` tools are listed.

### Gemini CLI

Google moved unpaid-tier and Google One users from Gemini CLI to Antigravity CLI on June 18, 2026 ([geminicli.com](https://geminicli.com)), so these steps are for people who have Gemini CLI.

One command installs xlsx-for-ai as a Gemini CLI extension (the server and the instructions Gemini reads):

```bash
gemini extensions install https://github.com/senoff/xlsx-for-ai
```

That installs from the latest GitHub release. To install from the newest code on `main` instead, add `--ref main`.

Start Gemini CLI and ask about a spreadsheet on your computer, for example "recalculate budget.xlsx and tell me which totals changed". The first request answers with a sign-in link and a short code: open the link, approve, then ask again. The extension runs the same `xlsx-for-ai-mcp` server through `npx`, pinned to a published version (each release updates the pin), so no global install is needed.

Or add just the server, without the extension:

```bash
gemini mcp add -s user xfa xlsx-for-ai-mcp
```

Hosted instead: `gemini mcp add -s user --transport http xfa https://api.xlsx-for-ai.dev/mcp`, then run `/mcp auth` in Gemini CLI and sign in to `xfa`.

Verify: `gemini mcp list` shows `xfa` as connected. In Gemini CLI, run `/mcp` and check that `xfa` lists the `xlsx_*` tools.

### ChatGPT and other assistants with remote connectors

Assistants that add a connector by URL use the hosted server instead of the npm package: add `https://api.xlsx-for-ai.dev/mcp` as a connector and sign in when asked. A remote connector cannot read files on your computer: give it a link to the file (shared as "anyone with the link can view") or use the upload link it offers.

### Zed

Open your settings file with the `zed: open settings file` command and add:

```json
{
  "context_servers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp",
      "args": []
    }
  }
}
```

Hosted instead: `"xfa": { "url": "https://api.xlsx-for-ai.dev/mcp" }`. With no `Authorization` header set, Zed asks you to sign in.

Verify: open Settings → AI → MCP Servers and check that the dot next to `xfa` is green ("Server is active"); the `xlsx_*` tools then appear in the agent panel.

### Windsurf

Windsurf's MCP docs now point to Devin Desktop. Its user config is `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`); `.devin/mcp_config.json` in a project works too. Older Windsurf builds used `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Hosted instead: `"xfa": { "url": "https://api.xlsx-for-ai.dev/mcp", "transport": "http" }`, then click **Authenticate** next to it under Customize → MCPs.

Verify: in the Agents window open Customize → MCPs; `xfa` should be in the "This computer" list with the `xlsx_*` tools. Press refresh there after editing the file. On an older Windsurf build, add the same `xfa` block through that build's own MCP settings.

### Cline

In Cline, click the MCP Servers icon, open the **Configure** tab and click **Configure MCP Servers**. Add `xfa` under `mcpServers` (the Cline CLI keeps the same file at `~/.cline/data/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp",
      "args": [],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Verify: `xfa` appears in Cline's MCP server list with the `xlsx_*` tools; try one tool call.

### VS Code with GitHub Copilot

Put the server in `.mcp.json` at the workspace root, or in `~/.copilot/mcp-config.json` for every workspace:

```json
{
  "mcpServers": {
    "xfa": {
      "type": "stdio",
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Or from a terminal (adds it to your VS Code user profile):

```bash
code --add-mcp '{"name":"xfa","type":"stdio","command":"xlsx-for-ai-mcp"}'
```

You can also run "MCP: Add Server" from the Command Palette and choose "Command (stdio)". Older setups use `.vscode/mcp.json`, which has the same entry under `"servers"` instead of `"mcpServers"`.

Hosted instead: `"xfa": { "type": "http", "url": "https://api.xlsx-for-ai.dev/mcp" }`, and click **Authenticate** when VS Code offers it.

Verify: run "Chat: Open Customizations" → MCP Servers (or "MCP: List Servers") and check that `xfa` is running with the `xlsx_*` tools. Then ask Copilot Chat something about a spreadsheet and confirm it calls an `xlsx_*` tool.

### Roo Code

Open the MCP settings view from the Roo Code pane, scroll down and click **Edit Global MCP** (`mcp_settings.json`, all workspaces) or **Edit Project MCP** (`.roo/mcp.json`):

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: `xfa` shows in the MCP server list, enabled, with the `xlsx_*` tools.

### Qoder

Qoder IDE: open Qoder IDE Settings (`⌘⇧,` on macOS, `Ctrl+Shift+,` on Windows), choose MCP, and on **My Servers** click **+ Add**. In the JSON file that opens, add:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

and click Save. Qoder CLI:

```bash
qoder mcp add -s user xfa -- xlsx-for-ai-mcp
```

Verify: in the IDE, `xfa` shows a link icon (connected); expand it to see the `xlsx_*` tools. In the CLI, `qoder mcp list` shows `xfa` (run `/mcp reload` in a session that was already open).

### JetBrains AI Assistant

Open Settings | Tools | AI Assistant | Model Context Protocol (MCP), click **Add**, choose STDIO, paste:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

choose global or project level, click OK, then Apply.

Verify: the Status column shows `xfa` running; click the icon in that column to see the `xlsx_*` tools.

### Junie

Junie (in JetBrains IDEs and Junie CLI) reads `~/.junie/mcp/mcp.json` (all projects) or `.junie/mcp/mcp.json` in a project. In the IDE: Settings | Tools | Junie | MCP Settings, click **Add** and edit the file that opens:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Hosted instead (Junie CLI): `"xfa": { "url": "https://api.xlsx-for-ai.dev/mcp" }`, then authorize it from the `/mcp` screen.

Verify: the IDE's MCP Servers list shows `xfa` with its status and the `xlsx_*` tools; in Junie CLI, `/mcp` shows it as Active.

### Amazon Q Developer CLI

AWS has renamed the Q Developer CLI to Kiro CLI ([upgrade to Kiro](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/upgrade-to-kiro.html)). After the upgrade the `q` commands below still work ([Kiro's migration guide](https://kiro.dev/docs/upgrade-guides/migrating-from-q/)); for Kiro's own commands see [Kiro](#kiro).

```bash
q mcp add --name xfa --command xlsx-for-ai-mcp
```

Hosted instead: add this to your agent config (in `~/.aws/amazonq/cli-agents/`):

```json
{
  "mcpServers": {
    "xfa": {
      "type": "http",
      "url": "https://api.xlsx-for-ai.dev/mcp"
    }
  }
}
```

start `q chat`, run `/mcp`, and open the sign-in link it gives while the session stays open.

Verify: `q mcp list` shows `xfa`; in `q chat`, `/tools` lists the `xlsx_*` tools.

### Goose

CLI: run `goose configure` → Add Extension → Command-line Extension, name it `xfa` and enter the command `xlsx-for-ai-mcp`. Desktop: Extensions → Add custom extension, type Standard IO, command `xlsx-for-ai-mcp`. Or add it to `config.yaml` (`~/.config/goose/config.yaml` on macOS and Linux; `goose info -v` prints the path):

```yaml
extensions:
  xfa:
    name: xfa
    type: stdio
    cmd: xlsx-for-ai-mcp
    args: []
    enabled: true
    timeout: 300
```

Hosted instead: `goose configure` → Add Extension → Remote Extension (Streamable HTTP), URL `https://api.xlsx-for-ai.dev/mcp`. Goose registers itself with the server and opens the browser to sign in.

Verify: `goose info -v` lists `xfa` with `enabled: true`; in a goose session, ask "what tools do you have?" and check that the `xlsx_*` tools are listed.

### opencode

```bash
opencode mcp add xfa -- xlsx-for-ai-mcp
```

In opencode 1.19.x (the current release) this writes the entry below to your global config, `~/.config/opencode/opencode.json` (or `opencode.jsonc` if you already have one):

```json
{
  "mcp": {
    "xfa": {
      "type": "local",
      "command": ["xlsx-for-ai-mcp"]
    }
  }
}
```

opencode's [MCP docs](https://opencode.ai/docs/mcp-servers) describe the newer version, where `opencode mcp add` writes to the project config, `--global` makes the server available in every project, and servers are nested under `mcp.servers` (`"mcp": { "servers": { "xfa": { ... } } }`) instead of directly under `mcp`.

Hosted instead: `opencode mcp add xfa --url https://api.xlsx-for-ai.dev/mcp`, then `opencode mcp auth xfa` (or `/mcps` in opencode) to sign in.

Verify: `opencode mcp list` shows `xfa` as connected (the hosted one shows "needs authentication" until you sign in).

### LM Studio

Needs LM Studio 0.3.17 or later. In the right-hand sidebar open the **Program** tab, click **Install → Edit mcp.json**, and add `xfa` (LM Studio uses the same `mcpServers` format as Cursor):

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp"
    }
  }
}
```

Verify: save, start a chat with a model that supports tools, ask "what tools do you have?" and check that the `xlsx_*` tools are listed.

### Kiro

Config file: `~/.kiro/settings/mcp.json` (all workspaces) or `.kiro/settings/mcp.json` in a workspace.

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp",
      "args": [],
      "disabled": false
    }
  }
}
```

Hosted instead: `"xfa": { "url": "https://api.xlsx-for-ai.dev/mcp" }`, and sign in when Kiro asks. Kiro CLI: `kiro-cli mcp add --name xfa --url https://api.xlsx-for-ai.dev/mcp`.

Verify: open the MCP Servers view in the Kiro panel and check that `xfa` is connected with the `xlsx_*` tools; in Kiro CLI, run `/mcp`.

### Warp

Open Settings → Agents → MCP servers (or "Open MCP Servers" from the Command Palette), click **+ Add** and paste:

```json
{
  "mcpServers": {
    "xfa": {
      "command": "xlsx-for-ai-mcp",
      "args": []
    }
  }
}
```

Or put the same block in `~/.warp/.mcp.json`. Hosted instead: `"xfa": { "url": "https://api.xlsx-for-ai.dev/mcp" }`; Warp opens the browser to sign in when it starts the server.

Verify: on the MCP servers page `xfa` is running (click **Start** if not) and lists the `xlsx_*` tools.

### Any other MCP client

Follow the app's own "add an MCP server" steps and give it one of these:

- Local (stdio): command `xlsx-for-ai-mcp` with no arguments, after `npm install -g xlsx-for-ai`. Or command `npx` with arguments `-y -p xlsx-for-ai xlsx-for-ai-mcp`.
- Hosted: the Streamable HTTP address `https://api.xlsx-for-ai.dev/mcp`, if the app can sign in to a remote server (OAuth). The server supports dynamic client registration, so no client ID is needed.

Name the server `xfa`. Verify: the app's MCP server list shows `xfa` with the `xlsx_*` tools.

### Custom agents / API

For custom MCP clients, the binary is `xlsx-for-ai-mcp` (stdio transport). Override the API base URL with the `XLSX_FOR_AI_API` env var for local dev against `http://localhost:3000`.

### Using the raw HTTP API

The MCP client is the easy path, but every tool is also a plain HTTP endpoint you can call from any language — no SDK required. Sign in with the OAuth device flow (RFC 8628) at `https://api.xlsx-for-ai.dev/oauth` (`/oauth/reg`, `/oauth/device/auth`, `/oauth/token`, with `resource=https://api.xlsx-for-ai.dev/mcp`), then `POST https://api.xlsx-for-ai.dev/api/v1/clients` with `Authorization: Bearer <access token>` returns `{ client_id, api_key }`. Call any tool with `Authorization: Bearer <api_key>`. Anonymous keys from earlier versions still work during the transition. See [What it costs](#what-it-costs) for the limits.

```bash
# Legacy keyless registration (still accepted during the transition; new integrations
# should use the device-flow sign-in above), then convert report.xlsx to Markdown.
# Needs jq, and bash or zsh. The base64 body is passed to curl through a
# process-substitution fd and the token through a --config heredoc on stdin, which
# keeps both out of the argument list. -fsS --max-time makes curl fail loudly on an
# HTTP error or a hang; the guard line stops on a failed key issuance.
KEY=$(curl -fsS --max-time 30 -XPOST https://api.xlsx-for-ai.dev/api/v1/clients \
  -H 'Content-Type: application/json' \
  -d '{"client_version":"2.0.0","platform":"cli"}' | jq -r .api_key)
[ -n "$KEY" ] && [ "$KEY" != null ] || { echo "key issuance failed"; exit 1; }

curl -fsS --max-time 120 -XPOST https://api.xlsx-for-ai.dev/api/v1/tools/xlsx_convert \
  --data-binary @<(base64 < report.xlsx | tr -d '\n' | jq -Rs '{file_b64: ., to: "md"}') \
  -H 'Content-Type: application/json' \
  --config - <<CFG
header = "Authorization: Bearer $KEY"
CFG
```

Files that are too large, and requests over your limit, come back as a typed JSON error with an `upgrade` field where a plan would help (see below).

Rate-limited, over-limit and oversize requests come back as a typed JSON error (`{ "error": { "code", "message" } }`) carrying an `upgrade` field with your options — see `GET /api/v1/reference` for the full contract.

Every error body is exactly that shape: `error.code` is the stable, machine-readable key to branch on, and `error.message` is the self-correcting detail that says what was wrong and what to change. A few codes add a documented extra field (for example `available_sheets` on a sheet-not-found refusal, or `upgrade` on a paywall refusal), but there is no finer error-subtype field on the wire; the server keeps a finer attribution for its own audit only.

**Convert can refuse with a typed `501`.** `xlsx_convert` converts `xlsx`, `xls`, `csv` and `json` inputs with the server's own engine only. When that engine declines a conversion of one of those inputs (for example some `to=csv` conversions of an `.xlsx` whose cells use a display format or an uncached formula the engine cannot reproduce exactly; the same file usually still converts with `to=xlsx` or `to=json`), the API returns HTTP `501` with `error.code` `capability_gap` and a message of the form "xlsx_convert isn't yet supported by our own engine for .xlsx files, and we don't fall back to a full-workbook recompute on this file type ...". It does not silently fall back to a compatibility library. It is not a client error and not transient, so retrying the same file does not help. Through the hosted MCP connector the same refusal arrives as a tool result with `isError: true` carrying that message. Exotic formats (`ods`, `xlsb`, `fods`, and the `xls`/BIFF8 write target) are still served by the legacy path and are unaffected.

The same governed contract is served read-only from two routes — discover the whole API without a key:

- **[`GET /api/v1/reference`](https://api.xlsx-for-ai.dev/api/v1/reference)** — a self-contained human HTML reference for the public-stable tools, including the on-ramp above.
- **[`GET /api/v1/openapi.json`](https://api.xlsx-for-ai.dev/api/v1/openapi.json)** — the versioned OpenAPI 3.1 contract, verbatim. Point codegen, Postman, or Scalar/Redoc at it.

## Claude Code plugin

A Claude Code plugin connects your agent to the hosted xlsx-for-ai tools for spreadsheet files and links (.xlsx, .xlsm, .xls, .csv, .tsv, a Google Sheet) and tells it when they help: when the answer depends on formula results, on whether saved values are current, or on handing back a working spreadsheet file.

```bash
claude plugin install xlsx-for-ai --marketplace senoff/xlsx-for-ai
```

That one command adds the marketplace and installs the plugin. It needs Claude Code 2.1.292 or later; run `claude update` first if yours is older.

Then, once: run `/reload-plugins` (or start Claude Code), run `/mcp`, choose the `plugin:xlsx-for-ai:spreadsheets` server and sign in in the browser. The plugin connects to the hosted endpoint `https://api.xlsx-for-ai.dev/mcp` (OAuth sign-in) and asks for the full tool list.

Version 0.1.1 renamed the server key in the plugin's `.mcp.json` from `xlsx-for-ai` to `spreadsheets`, so `/mcp` now shows `plugin:xlsx-for-ai:spreadsheets` instead of `plugin:xlsx-for-ai:xlsx-for-ai`. Claude Code reads the key from the plugin's own `.mcp.json` and nothing else reads it. If you are on 0.1.0, sign in once after updating, because the server has a new name.

What it does:

- Prints a short text at session start (startup, resume, clear and compact) that says when the xlsx-for-ai tools help, why, how to hand a file over from Claude Code, and every tool by name.
- Sends Shopify export files (products, inventory, collections, redirects, metafields) to the `shopify_*` tools, which build a file ready to import into Shopify (plus Google, Amazon, eBay and UPS feed files). They work on the file you give them and hand a file back; you import the result yourself.
- Adds a `spreadsheets` skill that applies when spreadsheet files are in play.
- Connects Claude Code to the hosted server.

What it does not do: it ships no engine. No calculation, parsing or conversion code of ours runs on your machine; the only thing that runs locally is `cat` printing the session-start text file. Files you give the tools are sent to the hosted service (a link, or a one-time upload). The plugin lives in `claude-code-plugin/`; the session-start text is generated from `claude-code-plugin/tool-manifest.json` by `scripts/plugin/generate-session-start.js`, and a test fails if they disagree. On Windows the hook works in Git Bash or PowerShell (`cat` is available in both).

---

## What it does

76 tools registered in `tools/list`, read live from the hosted service each time the server starts (a bundled copy covers a cold start with no network). Descriptions are intentionally rich — an agent reading a transcript can tell what each tool does and when to reach for it, without extra docs.

### Triage / orient

| Tool | What it does |
|---|---|
| `xlsx_doctor` | **One-call workbook health report.** HIGH/MEDIUM/LOW findings (macros, external links, hidden sheets, missing metadata, large images) + quick facts + feature flags. The first call to make on an unknown workbook. |
| `xlsx_topology` | One-call workbook orientation: sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot. |
| `xlsx_list_sheets` | List all sheet names and metadata. Fast first-call before reading. |
| `xlsx_schema` | Infer column types, nullable flags, header row, and sample values per sheet. |
| `xlsx_describe` | Pandas-style `.describe()` on every numeric column — count, mean, std, min, max, quartiles. |
| `xlsx_workbook_views` | UI state — frozen panes, zoom, active cell, hidden / veryHidden sheets, tab colors, active tab. |
| `xlsx_properties` | Workbook metadata — creator, modified, company, title, custom doc properties. |

### Read / write

| Tool | What it does |
|---|---|
| `xlsx_read` | Read a workbook — text, JSON, or markdown. Formulas, named ranges, layout, and data types preserved. Also reads a **live Google Sheet** by id (`source:"gsheets"`), read-only, with a read-only Google OAuth token you supply. |
| `xlsx_read_handle` | Read by server-side handle instead of bytes — for session flows where the workbook has already been uploaded and shouldn't be transferred again. |
| `xlsx_write` | Create or update a workbook from a structured spec. Multi-sheet, formulas, named ranges, table definitions. |
| `xlsx_data_clean` | Normalize messy data in place — trim whitespace, coerce types, dedupe rows, fix obvious encoding artifacts. Returns a cleaned copy + a change log. Save-As shape; never mutates the input. |
| `xlsx_diff` | Semantic diff between two workbooks — cell-level deltas, formula changes, structural shifts. Deterministic output. |
| `xlsx_redact` | Redact PII from a workbook before sharing. Server-side detection; returns redacted copy plus audit manifest. |
| `xlsx_convert` | 25+ in / 16 out formats (csv, tsv, html, ods, xls, xlsb, dif, sylk, prn, txt, dbf, eth, json, markdown, xlsx, etc.). For xlsx, xls, csv and json inputs there is no compatibility-engine fallback: if our own engine declines, the call fails with a typed `501` `capability_gap`. |
| `xlsx_validate` | Soundness check — parses the workbook with the server's own OOXML engine and reports whether it loads cleanly, with a per-sheet structural summary. |
| `xlsx_session_set_validations` | Configure per-session validation rules the server will apply to subsequent calls in the same session (e.g., reject rows missing required columns). Stateful — affects this session only. |

### Pandas-parity (compute fresh aggregates)

| Tool | What it does |
|---|---|
| `xlsx_filter` | Filter rows by predicate (column op value). Returns matched rows with optional projection. |
| `xlsx_aggregate` | Group-by + aggregate (sum / count / mean / min / max / median / std). |
| `xlsx_sort` | Multi-column sort with ascending / descending per column. |
| `xlsx_value_counts` | Frequency table for a column (pandas `.value_counts()`). |
| `xlsx_pivot` | Compute a fresh pivot table from raw data — pandas `pivot_table()` shape. |
| `xlsx_eval` | Evaluate freeform formulas or recompute cell refs with our own recalc engine — no third-party formula engine. A formula using a function we haven't implemented yet returns an honest "not supported yet" error, never a wrong value. |

### Structure-preservation — the moat (pandas drops every one of these on read)

| Tool | What it does |
|---|---|
| `xlsx_named_ranges` | List every named range with scope, ref, and value preview. |
| `xlsx_tables` | List Excel ListObjects (Tables) with column headers, data range, totals row. |
| `xlsx_formulas` | Dump every formula across the workbook (cell, sheet, formula text, cached value). |
| `xlsx_data_validations` | List cell-level validation rules (dropdowns, numeric/date bounds, text-length, custom). |
| `xlsx_hyperlinks` | List hyperlinks with kind classifier (external / internal / mailto / unknown). |
| `xlsx_conditional_formats` | List CF rules (color scales, data bars, icon sets, formula-based highlights, top-N, duplicates). |
| `xlsx_styles` | Number formats + fonts + fills + alignment, rolled up per sheet or detailed per cell. |
| `xlsx_comments` | Both legacy notes AND threaded conversations (multi-author, with display-name resolution). |
| `xlsx_protection` | Sheet locks + per-cell locked/hidden flags + workbook structure/window locks. |
| `xlsx_merged_cells` | Layout-aware merge listing with master values + kind heuristic (header / horizontal / vertical / block). |
| `xlsx_charts` | Chart spec (type, title, series formula refs, axis titles) — read straight from the chart XML parts most spreadsheet libraries ignore. |
| `xlsx_images` | Embedded image inventory (format, size, sheet, anchor cells). |
| `xlsx_pivot_tables` | Pre-existing pivot definitions — location, source, row/col/page/data fields with agg functions. |
| `xlsx_slicers_timelines` | Modern Excel filter UI — slicers (table/pivot bound) + timelines (date-range with selection). |
| `xlsx_external_links` | Workbook-to-workbook references with target classification + warning when paths break on share. |
| `xlsx_print_settings` | "What would Excel print?" — print area, paper size, margins, headers/footers, print titles. |
| `xlsx_form_controls` | Interactive widgets — checkboxes, buttons, drop-downs, spinners, scroll bars, list boxes — with linked cell + bounds. |
| `xlsx_macros` | VBA macro presence + module-name heuristics + safety advice (does NOT extract source by policy). |

### Integrations

| Tool | What it does |
|---|---|
| `xlsx_post_slack` | Post a workbook to a Slack channel as a file attachment with an optional message. BYOA — the agent supplies the user's Slack bot token (`xoxb-…`); the token is forwarded to Slack and never persisted. Uses Slack's external upload flow. |
| `xlsx_post_teams` | Post a workbook to a Microsoft Teams channel as a file attachment in a channel message, with an optional message. BYOA — the agent supplies the user's Microsoft Graph access token (JWT); the token is forwarded to Microsoft and never persisted. Uses Graph's filesFolder + upload-session + post-message flow. |

### Integrity verification

| Tool | What it does |
|---|---|
| `xlsx_stamp` | Sign a workbook with a cryptographic "integrity verification" stamp — Ed25519-signed claims (named factual checks + their pass/fail/skip status + a content hash) embedded in `docProps/custom.xml`. The stamp travels with the file across saves; a recipient can verify it later to confirm the file hasn't been tampered with since signing. Factual attestations only — never an opinion-shaped seal of approval. |
| `xlsx_verify_stamp` | Verify a workbook's embedded stamp. Returns (a) whether the Ed25519 signature is valid against the registered public key, (b) whether the workbook bytes match the hash IN the signed claims, and (c) the full check-result content of the stamp. Three distinct trust signals — signature integrity, content integrity, and what was originally attested. |
| `xlsx_receipt` | Attach an AI-generation receipt — Ed25519-signed claims describing the caller-declared agent identity (name, display name, identity URL), generation timestamp, content hash, optional source-file hashes, optional prompt hash, optional MCP tools called, and an optional description. Honesty boundary (load-bearing): the server signs the caller-declared `agent.name` — it does NOT verify the caller actually IS that agent. Cryptographic identity binding (per-agent issued signing keys) is v1.1+ scope. |
| `xlsx_verify_receipt` | Verify a workbook's embedded receipt. Returns the same three trust signals as `xlsx_verify_stamp` plus the caller-declared agent identity AS declared (no UI affordances implying cryptographic identity verification). Use to surface "where did this file come from?" — backed by the server's signature over caller honest declaration. |

### Healer — external-reference breakage

Workbooks rot. A file moves and `#REF!` propagates through every dependent formula. A Power Query connection embeds credentials nobody can rotate. A defined name points at an external workbook that doesn't exist anymore. The healer family diagnoses these classes and applies targeted cures — read-only diagnosis, simulated-before-applied repair, and a high-level intent path when the agent doesn't want to spell out individual cure operations.

| Tool | What it does |
|---|---|
| `xlsx_healer_diagnose` | Structured report of external-reference breakage — broken external refs, defined-name external refs, Power Query connections with embedded credentials, `#REF!` propagation maps, multi-hop chains. Read-only. |
| `xlsx_healer_simulate` | Show what a specific cure operation would change before applying it — same shape as `xlsx_healer_cure` but read-only. Use to preview impact when the agent is uncertain whether to proceed. |
| `xlsx_healer_cure` | Apply ONE specific cure operation (e.g., strip broken external refs, harmonize a defined name, replace `#REF!` propagation with a deterministic value). Save-As shape; the source workbook is preserved unless `confirm:true` is set with `mode:"in_place"`. |
| `xlsx_healer_intent` | High-level intent path — `make-it-work`, `make-standalone`, `migrate` — translated into the right sequence of cure ops. For when the agent knows the goal but not the operation. |

Tool responses include a citation footer and a `_meta` block (tool name, version, tier, request ID, `powered_by`). Both pass through verbatim; nothing is stripped.

---

## Tools

All **76 tools** the MCP server exposes (the hosted `tools/list`, read at start-up). Invoke any by asking your agent in plain English, or call the API/CLI directly.

**Read & explore**

- `xlsx_read` — read an .xlsx file by path and return a rendered markdown/JSON/SQL representation. Also reads a **live Google Sheet**: pass `source:"gsheets"` with the `spreadsheet_id` and a read-only Google OAuth token you supply (token-injected — read-only, no write; the server never mints or brokers Google credentials). Same rendered output as reading the equivalent `.xlsx`.
- `xlsx_read_handle` — read a workbook that has already been uploaded to the server via the chunked upload flow, by its server-side cache handle, WITHOUT re-transferring the bytes. Returns the same shape as xlsx_read (text / json / markdown) but skips the file_b64 round-trip.
- `xlsx_validate` — soundness check on a LOCAL .xlsx file — parses the workbook with the server's own OOXML engine and reports whether it loads cleanly (truncated zip, encrypted container, no worksheets, or a damaged sheet body each fail), with a per-sheet structural summary.

**Inspect structure**

- `xlsx_charts` — List every chart in a LOCAL .xlsx file with type (bar / line / pie / scatter / area / doughnut / radar / stock / surface / bubble), title, axis titles, and per-series formula refs (the cell ranges the chart pulls from). Sheet attribution via the OOXML drawing rel chain.
- `xlsx_comments` — list every cell comment in a workbook — both legacy notes (yellow stickies, cell.note) AND modern threaded comments (multi-author conversations stored separately in the OOXML zip). Per entry: kind, sheet, cell, author, text, plus any reply thread.
- `xlsx_conditional_formats` — list every conditional formatting rule in a workbook — color scales, data bars, icon sets, formula-based highlights, top-N, duplicate / unique values, contains-text, time-period, above-average. Per rule: range, type, operator, formulae, priority, stopIfTrue.
- `xlsx_data_validations` — list every cell-level data validation rule (dropdowns, numeric/date bounds, text-length caps, custom formulas) defined in a workbook — the constraints that Excel enforces when a human types into the cell.
- `xlsx_describe` — pandas-style df.describe() per column — count, nulls, unique, min/max/mean/std for numerics, dtype with purity score.
- `xlsx_external_links` — list every external workbook reference this file depends on — `=[Budget.xlsx]Sheet1!A1` style formulas. Per link: target path (decoded), classification (http / network share / absolute / relative), sheets pulled from the external workbook, count of cached cell values, and defined-name references.
- `xlsx_form_controls` — list every form control (Check Box, Button, Drop-down, List Box, Option Button, Scroll Bar, Spinner, Label, Group Box) in a workbook with the linked cell, current value, dropdown source range, and min/max/step bounds where applicable.
- `xlsx_formulas` — extract every formula in a LOCAL .xlsx workbook — cell coord (A1), formula text, cached result. openpyxl-style read-only metadata.
- `xlsx_hyperlinks` — list every hyperlink in a workbook with its anchor cell, target URL/anchor, display text, tooltip, and a kind classifier (external / internal / mailto / unknown).
- `xlsx_images` — List every embedded image in a LOCAL .xlsx file with format (png / jpg / gif / svg / bmp / tiff / emf / wmf), size in bytes, sheet attribution, and anchor cell range (the cells the image floats over). Reads xl/media/* + xl/drawings/* directly.
- `xlsx_list_sheets` — list sheet names, dimensions, and visibility for a LOCAL .xlsx file.
- `xlsx_macros` — Inspect xlsm / xlsb workbooks for VBA macro presence, vbaProject.bin size, and likely module names (ThisWorkbook / Sheet<N> / Module<N> / Class<N> / UserForm<N> via heuristic UTF-16LE scan). Returns short safety advice the LLM should relay to the user.
- `xlsx_merged_cells` — list every merged-cell region with master-cell value, range, span dimensions, and kind heuristic ("header" / "horizontal" / "vertical" / "block"). Pandas reads merged cells by dropping the relationship — it sees one value in the master cell and three blanks alongside. xlsx_merged_cells is the layout-aware view: "A1:D1 is ONE cell that says Q4 2024" rather than four cells where three are mysteriously empty.
- `xlsx_named_ranges` — list all defined names (named ranges) in a LOCAL .xlsx workbook — name, scope (workbook or sheet), kind (cell / range / formula), reference.
- `xlsx_pivot_tables` — List every PRE-EXISTING pivot table definition in a LOCAL .xlsx file (the ones an Excel user already built). Per pivot: sheet, name, location range, source range (or named-range / table reference), row / column / page fields, and data fields with their agg function (sum / count / average / max / min / product / stdDev / etc.).
- `xlsx_print_settings` — surface "what would Excel print right now" per worksheet — print area, orientation, paper size (A4 / Letter / Legal / Tabloid / etc.), scale or fitToPage, margins, headers/footers split into Excel's L/C/R zones, print titles (rows / columns repeated on every page), manual page breaks, plus B&W / draft / centered flags.
- `xlsx_properties` — Surface the workbook's identity card from a LOCAL .xlsx file. Core: creator, last_modified_by, created/modified/lastPrinted timestamps, title, subject, company, manager, keywords, category, description. Application: app name + version, doc security label, hyperlink base. Custom: every user-defined Info > Properties entry (Department, ReviewedBy, ApprovalRequired, etc.) with type tag and value.
- `xlsx_protection` — Surface every protection setting in a LOCAL .xlsx file so an agent knows what it can and cannot edit. Workbook-level (lockStructure, lockWindows), per-sheet (protected? password? hidden state?), per-action allow/block list (formatCells, sort, insertRows, pivotTables, etc.), and per-cell unlocked / hidden samples — these are the cells a human would actually be allowed to type into when the sheet is otherwise read-only.
- `xlsx_schema` — infer column schema of a LOCAL .xlsx file — types, nullable flags, header row, sample values.
- `xlsx_slicers_timelines` — List every slicer (interactive filter button) and timeline (date-range filter visual) in a LOCAL .xlsx file with their captions, source bindings (table column or pivot table), and timeline granularity (years / quarters / months / days) plus the currently-selected date range.
- `xlsx_styles` — surface cell formatting (number formats, fonts, fills, alignment) so an agent knows what a cell LOOKS like, not just its raw value. Default mode: per-sheet rollup of top-N number formats / fonts / fills with counts. Detailed mode (opt-in, capped at 1000 cells): per-cell breakdown for narrow queries.
- `xlsx_tables` — list every Excel ListObject ("Format as Table" structures) in a LOCAL .xlsx workbook — name, sheet, range, header/totals flags, columns.
- `xlsx_workbook_views` — Surface the UI state of a LOCAL .xlsx file — what a human sees when they open it in Excel. Per sheet: visibility (visible / hidden / veryHidden), view state, zoom, active cell + selection, frozen-pane breakdown, gridlines / row-col headers / ruler / RTL flags, tab color. Workbook level: which sheet is active when Excel opens.

**Query & analyze**

- `xlsx_aggregate` — pandas-style df.groupby([cols]).agg({col: func}) on a LOCAL .xlsx file. funcs: sum / mean / min / max / count / count_distinct.
- `xlsx_diff` — compute a semantic diff between two LOCAL .xlsx files — cell-level deltas, formula changes, added/removed rows.
- `xlsx_eval` — evaluate Excel formulas against a LOCAL .xlsx file with our own recalc engine. xlwings-style.
- `xlsx_filter` — pandas-style row filter on a LOCAL .xlsx file with predicates AND-combined: eq/ne/gt/gte/lt/lte/contains/in/is_null/not_null.
- `xlsx_pivot` — pandas-style pivot_table() on a LOCAL .xlsx file — reshape a flat table into a 2D matrix where rows are unique values of `index`, columns are unique values of `columns`, and cells are an aggregation of `values`.
- `xlsx_sort` — pandas-style df.sort_values() on a LOCAL .xlsx file with multi-column sort and per-column direction (asc/desc, default asc).
- `xlsx_topology` — one-call workbook orientation. Returns sheets × dimensions × formulas × named ranges × tables × validations × hyperlinks × merges in one shot, plus feature flags (macros / external refs / pivots / LAMBDA / dynamic arrays).
- `xlsx_value_counts` — pandas-style Series.value_counts() on one column of a LOCAL .xlsx file — count each unique value, sorted by frequency desc, with percentage.

**Clean & fix**

- `xlsx_data_clean` — AI-native data cleaning for a LOCAL .xlsx file. Scans for the seven most common data-grime issues — NA variants (N/A, NA, null, -), merged-cell residue, type-coercion mistakes (numeric-as-text / date-as-serial / leading-zero stripped), trailing-row noise (footers / totals), header-row-not-first (preamble before headers), encoding glitches (UTF-8-as-CP1252 mojibake), and duplicate column headers — and either flags them (diagnose mode) or applies deterministic fixes (execute mode).

**Convert**

- `xlsx_convert` — universal spreadsheet format converter. Reads ANY of 25+ input formats (xlsx, xlsb, xlsm, xls, ods, fods, numbers, csv, tsv, dbf, lotus 1-2-3, quattro pro, sylk, dif, html, rtf, etc.) and emits ANY supported output format (xlsx, csv, json, md, html, etc.).

**Write (new file)**

- `xlsx_redact` — redact PII and sensitive values from a LOCAL .xlsx file before sharing or archiving.
- `xlsx_write` — create or update a LOCAL .xlsx file from a structured spec.

**Integrity & verification**

- `xlsx_healer_cure` — Apply ONE specific cure operation against a diagnosed workbook. Operations: rename_move (rewrite ref paths), pattern_bulk (regex-style ref rewrites), source_deleted_freeze (replace broken refs with cached values), source_deleted_redirect (point at a replacement file), source_deleted_localize (snapshot external source into a local copy), permission_denied (strip credentials), structure_changed (rewrite formulas for moved cells), format_change (re-link after extension change), make_standalone (fully dereference all externals). Returns cured workbook bytes + receipt.
- `xlsx_healer_diagnose` — produce a structured diagnostic report of external references that are broken or at risk in a workbook. Returns five classes of finding: (1) external-workbook references that can't resolve, (2) defined-name external refs, (3) Power Query connections with embedded credentials, (4) #REF! propagation maps from upstream breakage, (5) multi-hop chains (workbook → workbook → workbook). Findings carry reference_id keys that downstream cure operations key on.
- `xlsx_healer_intent` — Goal-driven healing. Caller declares an INTENT (`make-it-work`, `make-standalone`, or `migrate`) instead of a specific cure operation; Healer plans the operation sequence + applies it. make-it-work: minimum surgery to clear errors. make-standalone: fully de-externalize (snapshot every external dep). migrate: rewrite all references against a from/to prefix pair. Returns the planned operations, cured bytes, and an unactionable list.
- `xlsx_healer_simulate` — simulate recipient-side accessibility of a workbook's external references. Given a list of paths the recipient CAN see (`accessible_paths`), returns which references will still resolve at the recipient end and which will break (and why). Read-only; produces no output workbook.
- `xlsx_receipt` — Attach an AI-generation receipt to a LOCAL .xlsx file — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by THIS agent, at THIS time, against THESE inputs." Returns the receipted workbook as base64 in _meta.file_b64; pass out_path to write to disk.
- `xlsx_stamp` — Sign a LOCAL .xlsx file with a "workbook integrity verification" stamp — a cryptographic attestation embedded in docProps/custom.xml that says "this file was generated by these tools, passed these N specific checks, signed at this time, and hasn't been tampered with since." Factual claims only (never an opinion-shaped seal of approval). Returns the stamped workbook as base64 in _meta.file_b64; pass out_path to write to disk.
- `xlsx_verify_receipt` — verify a workbook's embedded AI-generation receipt. Returns whether the signature is valid, whether the recomputed content hash matches the hash IN the receipt, and the full caller-declared claims (agent identity, generation timestamp, source-file hashes, prompt hash, MCP tools called, description).
- `xlsx_verify_stamp` — verify a workbook's embedded integrity-verification stamp. Returns whether the cryptographic signature is valid, whether the workbook bytes match what was signed (recomputed hash vs hash IN the stamp), and the full check-result content of the stamp.

**Integrations**

- `xlsx_post_slack` — upload a local .xlsx file to a Slack channel as a file attachment, with an optional accompanying message.
- `xlsx_post_teams` — Upload a local .xlsx file to a Microsoft Teams channel as a file attachment, with an optional accompanying message.

**Session**

- `xlsx_session_set_validations` — configure per-session data-validation rules the server will apply to subsequent calls in the same session (e.g., reject rows missing required columns, enforce enum values on a category column, range-bound numeric inputs). Stateful — affects this session only.

**One-call capstone**

- `xlsx_doctor` — ONE-CALL workbook health report for a LOCAL .xlsx file. Scans for macros, external workbook references, hidden / veryHidden sheets, missing creator metadata, large embedded images, and surfaces interesting feature flags (LAMBDA, dynamic arrays, pivot cache, slicers, threaded comments). Findings ranked HIGH / MEDIUM / LOW. Plus quick_facts: sheet count, formulas, named ranges, merges, hyperlinks, validations, images, file size.

**Check**

- `xlsx_check` — find error cells, saved values that no longer match their formulas (recomputed and compared), ranges that stop short of the data, and structural problems, each with a location and a one-line fix.
- `csv_check` — verify CSV structure and injection safety before the file is imported anywhere else.

**Privacy & hidden content**

- `xlsx_pii_scan` — find personal data (IDs, emails, phone numbers, names and addresses) in a workbook.
- `xlsx_pii_clean` — remove the personal data you select (`selection`), as a copy by default; `simulate` previews it.
- `xlsx_vault_scan` — find hidden or risky content: macros, external links, embedded objects, hidden sheets.
- `xlsx_vault_cure` — remove the hidden or risky content you select (`selection`), as a copy by default.

**Shopify files (file in, import-ready file out)**

- `shopify_products_import`, `shopify_products_import_fix`, `shopify_collections_import`, `shopify_inventory_import`, `shopify_url_redirects_import`, `shopify_metafields_safe_reimport`, `shopify_variant_metafields_import`, `shopify_product_metafields_import` — turn a spreadsheet into a Shopify import file, or repair a broken one.
- `shopify_google_feed`, `shopify_amazon_feed`, `shopify_ebay_feed` (needs `category_map` and its `options`), `shopify_ups_feed` — turn a products or orders export into a marketplace or carrier feed.

**Catalog pull and import (Printful, Printify)**

- `printful_catalog_pull`, `printify_catalog_pull` — pull catalog products into a snapshot; `printful_catalog_import`, `printify_catalog_import` — turn a snapshot into a Shopify import file.

**Importable (Shopify files, beta)**

- `importable_entities`, `importable_convert` — list what can be driven, and convert a file for an entity.

**Uploads and long jobs**

- `xlsx_upload_link` — get a one-time link to send a file that is on your computer or attached in chat, then use the handle it returns with any tool.
- `xlsx_pii_job_status` — check a personal-data clean that is still running.

---

## Functions

`xlsx_eval` recalculates formulas with our own recalc engine, and it computes over 350 Excel functions today, plus the functions only Google Sheets has, with more added as they are built. Coverage spans the standard function families: Math & trig, Statistical, Financial, Date & time, Text, Logical, Lookup & reference, Information, and Engineering. The full served list is on the Functions section of https://xlsx-for-ai.dev.

A function the engine does not serve yet returns an honest "not supported yet" error, never a guessed value. Functions that reach outside the workbook, such as `WEBSERVICE`, `RTD` and `STOCKHISTORY`, are not served, so a recalc can't reach off-workbook.

---

## FP&A workflows

xlsx-for-ai is built for agents working on real financial spreadsheets. Common workflows:

**Budget vs. actual variance analysis**
```
xlsx_read → extract actuals and budget → agent computes variances → xlsx_write → deliver updated workbook
```

**Month-end reconciliation**
```
xlsx_read (bank export) + xlsx_read (GL extract) → agent matches rows → xlsx_diff → audit trail of unmatched items
```

**Audit-trail extraction**
```
xlsx_schema → identify change-log columns → xlsx_read with sheet filter → agent summarizes changes by author/date
```

**Multi-entity consolidation**
```
xlsx_read × N entity files → agent aggregates → xlsx_write → consolidated workbook with intercompany eliminations noted
```

**Pre-share PII redaction**
```
xlsx_redact → strips SSNs, emails, employee IDs → redacted file safe for external distribution
```

These workflows are the reason tool descriptions are FP&A-legible: when a developer builds an agent for a finance team, the agent's LLM reads the tool descriptions and routes correctly without extra prompt engineering.

---

## Reliability features

- **Deterministic diffs.** `xlsx_diff` produces identical output for identical inputs — safe to version-control, safe to assert against in CI.
- **Confidence-rated schema inference.** `xlsx_schema` returns type confidence scores alongside inferred types. Agents can branch on confidence rather than trusting a blind guess.
- **Audit trail.** Every tool call — success or failure — is logged server-side with timestamp, client ID, endpoint, file size, latency, and error class.
- **Hardened input validation.** Four pre-engine guards on every uploaded buffer: billion-laughs XML bomb defense, control-character stripping, worksheet buffer ceiling (slow ZIP-bomb defense), and typed error chaining. Applied before the xlsx engine sees any bytes.
- **Agent-readable errors.** Rate-limit and validation errors return structured JSON — agents can read them and prompt the user intelligently, not just surface a status code.

---

## Privacy

Files are transmitted to `https://api.xlsx-for-ai.dev` over HTTPS and processed in memory. Files are not persisted beyond the duration of a single request. Sign-in is with a Google account; the address is used only to identify your account, and no password is stored.

See [PRIVACY.md](PRIVACY.md) for the full data-handling policy.

---

## What it costs

All the tools are included. You sign in once on first use (a link and code in your editor, or `xlsx-for-ai login` in a terminal). The first 1,000 people to register get 500 files a month free. Everyone after gets 10 free files, then $25 a year for 10,000 files a month. Sign-in is with Google. File-size limits are the same on every plan: .xlsx up to 100 MB, .xls up to 100 MB, .csv up to 200 MB. The service shows these limits in its own messages when you reach them.

---

## License

The npm client (`xlsx-for-ai`, this package) is MIT. The hosted API server (`xlsx-for-ai-server`) is proprietary — engine IP, rendering pipeline, and semantic-diff algorithm are not open source.

---

## Architecture

```
agent (Claude Code / Claude Desktop / Cursor / Continue / Codex / Gemini CLI / Zed / Windsurf /
       Cline / VS Code / Roo Code / Qoder / JetBrains / Amazon Q / Goose / opencode / LM Studio /
       Kiro / Warp / custom)
  └── MCP stdio
        └── xlsx-for-ai-mcp  (this package, ~200 lines)
              └── POST /api/v1/tools/<name>  →  api.xlsx-for-ai.dev
                    └── server-side engine (own OOXML/CSV engine, formula eval, schema inference, redaction)
```

**Requirements:** Node.js 22+. 1.5.x line stays maintained on `main` for users who cannot upgrade.

---

## First-run sign-in

```bash
xlsx-for-ai login
```

Prints a link and a short code. Open the link in any browser, sign in with Google, approve, and the CLI stores your key in `~/.xlsx-for-ai/config.json`. Running any command with no stored key in an interactive terminal starts the same flow automatically. `xlsx-for-ai login --force` signs in again.

**Using it from an editor or desktop app (no terminal).** You do not need to run anything first. The first time you ask the assistant to use a spreadsheet tool, it replies with a sign-in link and a short code instead of an answer. Open the link in a browser, check the code matches, and approve. Then ask again: the request works, with no restart. If you ask again before approving, you get the same link and code. If the link runs out (about 15 minutes) or you decline it, the next request gives you a fresh one.

**A terminal command with no screen to answer on** (for example a script, or a command run by another program). The command prints the link and code to the error stream and waits up to 60 seconds for you to approve. Approve in time and it carries on with your request. If you do not, it stops and tells you to approve and then run the same command again. The second run picks up the same code, so there is nothing new to copy, and it finishes at once if you have approved in the meantime. To change the wait, set `XFA_LOGIN_WAIT_SECONDS` (for example `XFA_LOGIN_WAIT_SECONDS=120`).

In automated runs (CI), and in any run where you set `XFA_NONINTERACTIVE=1`, nothing waits and no sign-in is started. With no key the command stops straight away and says so. For an automated run, sign in once on a computer where you have a terminal, then pass the `api_key` value from `~/.xlsx-for-ai/config.json` to the run as the environment variable `XLSX_FOR_AI_KEY` (keep it in your secret store). That variable wins over the saved file when both exist.

**If the saved key is rejected.** In an editor or desktop app, the next request shows a fresh sign-in link and keeps your saved key until you approve the new one. In a terminal, run `xlsx-for-ai login --force`.

**Messages you may see.** When you hit a usage limit, the message comes from the service itself. A 402 gives its message and a link to upgrade, and a 429 gives its message and when to try again. A 501 means that function is not built yet, nothing is wrong with your file, and trying again will not help; the terminal command exits with code 5 for it (3 means the service could not be reached or had a fault, 4 means a file or link problem, 2 means a usage mistake, 1 anything else).

**Updating.** If this copy cannot update itself (a read-only install, a container), the tool results say a newer version exists and give the command to update. An assistant that can run commands can do it for you; otherwise run `npm install -g xlsx-for-ai@latest` in a terminal and restart the app. Set `XFA_NO_AUTO_UPDATE=1` to turn the self-update and this notice off.

**Links work too.** Besides a file saved on your computer, you can pass a link in the file path field: a public web link, or a Google Sheets or Drive link shared as "anyone with the link can view". The server downloads it and reads it. If a link cannot be opened, download the file and give its path.

**Running in Docker.** The image no longer skips sign-in. The first request prints a sign-in link and code. Your key is stored in the container at `/home/node/.xlsx-for-ai`, so mount a volume there to keep it between runs, for example `-v xfa-config:/home/node/.xlsx-for-ai`.

Keys minted by versions before 4.1.0 keep working for now. When the service marks a key as one that will stop, the tool result says so in plain words; no date is promised here.

## Config

Stored at `~/.xlsx-for-ai/config.json`. Created automatically on first run. Beside it, `pending-login.json` holds a sign-in that was started and is waiting for your approval (so the rerun shows the same code); it is removed once you are signed in or the code ends. The folder can be moved with `XFA_CONFIG_DIR`.

```json
{
  "client_id": "<uuid>",
  "api_key": "<opaque>",
  "registered_at": "2026-05-05T00:00:00.000Z",
  "telemetry": false,
  "consent_version": 1
}
```

Telemetry is opt-in:

```bash
xlsx-for-ai --enable-telemetry
xlsx-for-ai --disable-telemetry
xlsx-for-ai --telemetry-status
```

**Privacy modes** — workbook capture is off for every account (since 2026-10-14). `XFA_PRIVACY=strict` also turns off the 60-minute download copy of files a tool produces. See [PRIVACY.md](PRIVACY.md):

```bash
# Per-session flag (applies to all tool calls in the CLI invocation)
xlsx-for-ai --privacy=strict myfile.xlsx

# Environment variable (applies globally to all requests in the process)
XFA_PRIVACY=strict xlsx-for-ai myfile.xlsx

# In MCP server config (applies to all tool calls from the MCP server):
# Set XFA_PRIVACY=strict in your MCP server's env block
```

Delete the config to reset your client ID and API key:

```bash
rm ~/.xlsx-for-ai/config.json
```

---

## Migration from 1.5.x

| Was | Now |
|---|---|
| All rendering local | All rendering server-side |
| `xlsx-for-ai <file>` CLI | Same — still works |
| `cursor-reads-xlsx` | Still works — back-compat alias |
| `--list-sheets`, `--schema`, `--diff`, etc. | Moved to MCP tools (`xlsx_list_sheets`, `xlsx_schema`, `xlsx_diff`) |
| `--export-redacted-workbook` | Moved to `xlsx_redact` MCP tool |
| Heavy npm install (~50 MB) | Thin install (~2 MB); engine stays server-side |
| PII detection, region scoring | Moved server-side; not exposed in the npm package |

The config file at `~/.xlsx-for-ai/config.json` is extended in-place — existing telemetry consent is preserved.

---

## Security

See [SECURITY.md](SECURITY.md). All file content is transmitted to `https://api.xlsx-for-ai.dev` over HTTPS. Files are not retained beyond the duration of a single request.

<!-- ci-smoke-test: 2026-05-19 grace-review workflow -->
<!-- retry: llm-review vendored -->
