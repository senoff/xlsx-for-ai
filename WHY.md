# Why xlsx-for-ai exists

*A plain-English version. For the technical reference, see [README.md](README.md).*

## The problem you've probably hit

You have a spreadsheet — a budget, a financial model, a tax estimate, a list of customers. You ask Claude (or ChatGPT, or Cursor) for help with it.

So you copy and paste a section into the chat. The AI gives you advice that sounds reasonable but feels generic. It misses the broken formula in row 47. It doesn't notice that one tab's totals don't match another tab's source. It can't tell you why the gross margin number changes when you add a new column. It treats your spreadsheet as a blob of numbers — because that's all it can see.

You're not going crazy. The AI literally cannot read the file. It can read text, code, even images of your spreadsheet — but the actual `.xlsx` binary is invisible to it. Formulas, formatting, named ranges, links between sheets — all of that disappears the moment you hit copy-paste.

## What changes when you install this

Once `xlsx-for-ai` is on your machine, your AI tools (Claude, Cursor, Copilot, ChatGPT desktop apps with code execution) can finally **read your spreadsheet the way they read everything else** — every formula, every colored cell, every hidden row, every formula reference between sheets.

Now when you ask for help, you get a real review:

- *"Cell B47 has `#REF!` — it's pointing at a sheet you renamed last week."*
- *"Your gross margin formula in row 12 references the wrong column on the COGS tab — it's pulling Q3 numbers into the Q4 totals."*
- *"This 'Total' cell on the Summary tab shows $312k, but if I add up the source rows on the Detail tab I get $327k. Something's off."*

That's the difference between a friend skimming the printed numbers and an analyst who actually opens the file.

## Things that become possible

A few examples people find useful:

- **Have your AI find errors in a financial model** before you send it to your accountant or your board.
- **Compare two versions of the same spreadsheet** ("what changed between V11 and V14?") and get a list of every cell that moved.
- **Turn a CSV export from QuickBooks into a clean SQL database table** in one command, with the column types figured out automatically.
- **Walk through a 50-tab model someone else built** and have the AI explain how the sheets reference each other.

But the biggest unlock is the next thing.

## Now your AI can hand you back the file — not just words

Before, even once AI could read your spreadsheet, it could only *tell* you what to change. You'd still have to translate its advice into actual cell edits yourself. Tedious for two cells. Impossible for fifty.

Now the AI can do the editing for you. Same starting moment — you ask Claude to review your tax estimate, or update Q4 numbers in your forecast, or fix a broken cap table — but instead of describing the corrections, it builds you the actual fixed `.xlsx` and hands it back.

A real moment that gets unlocked:

> **You:** *"Here's our 2026 budget V11. Sales asked us to add a Travel line and bump Marketing to $52K each quarter. Update it."*
>
> **Claude (after a moment):** *"Done. I added a Travel row at the bottom with placeholder zeros (since you didn't give numbers), bumped Marketing to $52,000 across all four quarters, and updated the totals row to reflect the new sum. Here's V12 — I left a note in the file explaining everything I did."*

You open V12 in Excel. Marketing is updated. Travel exists. Totals are right. Then you flip to the rightmost tab — `_xlsx-for-ai` — and find what looks like a careful editor's notes on the changes.

## What's in the review tab

It's the AI's note to you about exactly what it changed and why, written in plain English. For each kind of change, you get a small block like this:

> **Issue: Marketing line update** *(4 cells)*
>
> **What happened.** You asked to bump Marketing to $52,000 per quarter.
>
> **What we did.** Updated B12, C12, D12, E12 to $52,000 each.
>
> **Risk.** The totals row (row 20) recomputes automatically — confirm the new bottom-line totals match what you expected.
>
> **Alternative.** If you wanted Marketing scaled differently per quarter (e.g., higher in Q4), tell me and I'll redo it.

You can read the whole tab in 30 seconds. Then you either accept what the AI did, or push back on any individual item. Same shape as a careful editor marking up your draft — observation, reasoning, and a clear way to override.

This is on purpose. The tool is designed around the **supervisor** model: AI does the work, but the human stays in control of every decision. The review tab is what makes that real — without it, the AI would be making silent changes you'd only discover by accident later. With it, every choice the AI made is visible, named, and reversible.

## Why this matters

Without the corrected file, AI is a really expensive consultant. It looks at your spreadsheet, talks for a while, and leaves you with a list of things to do yourself. No leverage on the actual work.

With the corrected file, AI is more like a junior analyst. It does the work, hands you the result, explains its reasoning, and waits for your review. Same role you've always wanted — without the hourly rate.

## How to actually use it

You don't run anything. Your AI does.

1. **Install once.** A programmer (or you, if you're comfortable with one terminal command) runs `npm install -g xlsx-for-ai`. Then forget about it.
2. **Drop a file into Claude, Cursor, Copilot, or ChatGPT** (the desktop apps with code execution, or any agent setup that can run commands). The AI picks up the tool automatically when it sees a spreadsheet.
3. **Ask whatever you want** — review, fix errors, update numbers, generate reports, compare versions, restructure.
4. **The AI hands back** either a text answer (when that's what you asked for) or a real `.xlsx` file with the review tab (when you asked for changes).

Most users never type a command.

If you're the programmer doing the install, the [README](README.md) has the full reference. If you're handing this to a programmer to set up for you, that link is what they'll need.

## Why this didn't exist before

Spreadsheet libraries are designed for developers building software *on top of* spreadsheets. They output JavaScript objects, database rows, raw bytes — formats other programs consume. None of them were designed for the case where the consumer is a language model and the goal is a text format the model can actually understand.

`xlsx-for-ai` is the first one built specifically for that. The output is shaped for an LLM's context window — markdown tables when the model just needs to read, structured JSON when it needs to reason, token-aware truncation when the spreadsheet is too big to fit, and a real `.xlsx` writer that produces a file you can hand back to a human along with a built-in note explaining everything that changed.

It's a small tool. It just happens to fix the one thing standing between AI assistants and the file format most knowledge work actually lives in.

## Privacy contract

We never auto-send workbook data. Anonymous crash telemetry is opt-in via `xlsx-for-ai --enable-telemetry`; even then, we receive only error type, error message (sanitized — paths scrubbed, capped at 200 chars), and tool/Node/OS version — no paths, no cell values, no identifiers. Nothing leaves your machine unless you choose to enable it.
