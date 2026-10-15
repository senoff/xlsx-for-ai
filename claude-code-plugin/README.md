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

The first time Claude uses a tool, sign in when prompted (run `/mcp`, pick the spreadsheets server, and sign in with Google or an email link).

## Where your files go

Your spreadsheet files are sent over HTTPS to our hosted server at `https://api.xlsx-for-ai.dev/mcp` for processing. Nothing runs on your machine and no engine is installed. Read the full data handling statement at https://xlsx-for-ai.dev/privacy/ before you use it with sensitive files.

## What the plugin contains

- `.mcp.json`: one remote MCP server, `spreadsheets`, at `https://api.xlsx-for-ai.dev/mcp`. It sends one fixed header, `x-xfa-toolset: all`, and no credentials.
- `hooks/hooks.json`: a SessionStart hook that prints `hooks/session-start.txt`, a plain text note telling Claude when to use these tools. It runs no other command and sends nothing.
- `skills/spreadsheets/SKILL.md`: a skill with the same guidance.

## Support

Questions and bug reports: https://github.com/senoff/xlsx-for-ai/issues. Documentation: https://xlsx-for-ai.dev/developers/. License: MIT.
