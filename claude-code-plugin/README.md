# xlsx-for-ai plugin

This plugin connects Claude to the hosted xlsx-for-ai spreadsheet tools. Claude's own file reading sees only the values saved in a workbook. These tools recalculate formulas with a real engine, check a sheet for errors and stale values, and write real .xlsx files back.

## What it does

- Recalculates formulas, so you get fresh results instead of the values cached at the last save.
- Checks a workbook for error cells, ranges that stop short, and other structure problems.
- Reads .xlsx, .xlsm, .xls, .csv, .tsv and Google Sheets that are shared by link.
- Cleans data, finds and redacts personal data, compares two versions, and writes a real .xlsx file.

## Install

```
claude plugin install xlsx-for-ai --marketplace senoff/xlsx-for-ai
```

This needs Claude Code 2.1.292 or later. On older versions, run `claude plugin marketplace add senoff/xlsx-for-ai` and then `claude plugin install xlsx-for-ai@xlsx-for-ai`. If you added the plugin from the claude.ai directory, Claude Code loads it for you as `xlsx-for-ai@synced`.

Then:

1. Restart Claude Code (quit it and start it again), so it loads the plugin. The xlsx-for-ai tools are there at once.
2. Ask Claude about a spreadsheet.
3. The first time, Claude shows you a sign-in link and a code. Open the link, check that it shows the same code, and sign in with Google or an email link.
4. Ask again. It works now, with no restart, and you stay signed in after later restarts (a sign-in unused for 30 days ends, and the next call shows a new link).

The plugin makes a random install id the first time it starts and keeps it in its own data folder (`~/.claude/plugins/data/`), readable only by you. It sends the id with each request so the server knows this install once you have signed in. Uninstalling the plugin removes it.

## Where your files go

Your spreadsheet files are sent over HTTPS to our hosted server at `https://api.xlsx-for-ai.dev/mcp` for processing. No engine is installed or runs on your machine. Read the full data handling statement at https://xlsx-for-ai.dev/privacy/ before you use it with sensitive files.

## What the plugin contains

- `.mcp.json`: one remote MCP server, `spreadsheets`, at `https://api.xlsx-for-ai.dev/mcp`. It sends one fixed header, `x-xfa-toolset: all`, and the install id header, `x-xfa-install`.
- `scripts/install-id.sh`: a short shell script Claude Code runs when it connects to the server. It makes the install id once (64 random hex characters), keeps it in the plugin's data folder and prints it as a header. It reads no other file and sends nothing itself.
- `hooks/hooks.json`: a SessionStart hook that prints `hooks/session-start.txt`, a plain text note telling Claude when to use these tools. It runs no other command and sends nothing.
- `skills/spreadsheets/SKILL.md`: a skill with the same guidance.

## Support

Questions and bug reports: https://github.com/senoff/xlsx-for-ai/issues. Documentation: https://xlsx-for-ai.dev/developers/. License: MIT.
