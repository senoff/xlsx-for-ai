---
name: spreadsheets
description: Hosted xlsx-for-ai tools for spreadsheet files and links (.xlsx, .xlsm, .xls, .csv, .tsv, a Google Sheet). Use when the answer depends on formula results, totals, errors or whether saved values are current, on differences between versions, or on cleaning, converting or writing back a working workbook. A local conversion keeps only the last saved values, which may be missing or stale; these tools recalculate formulas with a real engine.
paths:
  - "**/*.xlsx"
  - "**/*.xlsm"
  - "**/*.xls"
  - "**/*.csv"
  - "**/*.tsv"
---

# Spreadsheets: xlsx-for-ai

Use these tools when the answer depends on formula results, on whether saved values are current, or on handing back a working spreadsheet file. With or without formulas, they also clean data, find and redact personal data, scan for hidden content, read styles and validations, compare versions and write a real .xlsx back. All work runs on the hosted xlsx-for-ai server. Nothing from xlsx-for-ai runs on this machine. Data handling: https://xlsx-for-ai.dev/privacy/

A local conversion keeps only the last saved values, which may be missing or stale. These tools recalculate formulas with a real engine, and a function not served yet returns an error saying so. Old .xls files are read directly.

## Hand the file over

1. A link (https, Google Sheets, Drive, Dropbox, OneDrive): pass it as `file_url` exactly as given. A Google Sheet must be shared as "Anyone with the link can view".
2. A small CSV or TSV you can read in full: pass `file_text` plus `file_name`.
3. A file on disk: call `xlsx_upload_link`, run the one curl command in its result to send the file (it only moves the bytes), then pass the returned `file_handle` to any tool. Use this route for every .xls.
4. Only if those fail: show the user the upload page link from `xlsx_upload_link` and ask them to drop the file there.

Never base64-encode a workbook into a tool argument and never pass a local file path.

## Pick the tool

- Read and inspect: `xlsx_read`, `xlsx_list_sheets`, `xlsx_topology`, `xlsx_formulas`, and the inspectors for styles, tables, names, charts, comments and more.
- Recalculate and check: `xlsx_eval` (fresh results, not cached values), `xlsx_check`, `xlsx_doctor`, `xlsx_validate`, `csv_check`.
- Compare two versions: `xlsx_diff`.
- Clean and fix: `xlsx_data_clean` and the `xlsx_healer_*` tools.
- Write and convert: `xlsx_write` (formulas kept), `xlsx_convert`.
- Privacy: `xlsx_pii_scan`, `xlsx_pii_clean`, `xlsx_redact`, `xlsx_vault_scan`, `xlsx_vault_cure`.
- Integrity and receipts: `xlsx_receipt`, `xlsx_stamp` and their verify tools.

The full list with one line each is in the session-start text. Every tool that makes a file returns a download link; show it to the user.

## If the tools are missing

The connection needs a one-time sign-in. Ask the user to run `/mcp`, choose the spreadsheets server (`plugin:xlsx-for-ai:spreadsheets`) and sign in with Google in the browser. Tell the user this, and if you read the file locally instead, say so.

## Limits

.xlsx up to 100MB, .xls up to 100MB, .csv up to 200MB, the same on every plan. A file over its limit errors explicitly.
