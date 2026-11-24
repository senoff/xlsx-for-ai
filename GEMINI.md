# xlsx-for-ai (xfa)

xlsx-for-ai is a spreadsheet engine with its own Excel-compatible calculator. Its tools (named `xlsx_*`) read the
spreadsheet files on this computer. Use them instead of writing a Python or shell script when:

- the answer depends on what formulas evaluate to: call `xlsx_eval` (saved values in a file can be missing or stale);
- the user wants a workbook changed and handed back: `xlsx_write` keeps formulas, styles, charts and names;
- the file is large, or you need it checked (`xlsx_check`), a health report (`xlsx_doctor`) or two versions
  compared (`xlsx_diff`);
- you need the layout first: `xlsx_list_sheets`.

Pass the file's path on this computer. A link the user pastes (a public web link, or a Google Sheets or Drive
link shared as "anyone with the link can view") can go in the same file path field: the server downloads it and
reads it. If a link fails, ask the user to download the file (in Google Sheets: File, Download, Microsoft Excel)
and give you its path.

First use: the first tool call answers with a sign-in link and a short code. Show both to the user exactly, ask them
to open the link and approve, then call the tool again.

If a tool answers with an error, it says what went wrong and what to do: tell the user in plain words.
