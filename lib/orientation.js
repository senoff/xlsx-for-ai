'use strict';

/**
 * Post-registration orientation block (XLS-264).
 *
 * The setup instant is the one moment we have the user's terminal. This block
 * orients them to xfa + the tool list and opens the two inbound channels
 * (`xfa feedback`, `xfa support`). It is surfaced:
 *   - after a FRESH MCP registration line in postinstall / `setup` (never on the
 *     "no change" noop path — quiet on a re-install), and
 *   - always on bare `xfa` (no args) and `xfa --help`.
 *
 * The COPY here is the amendable surface (Bob may flip wording); the structure
 * is set. It lives in ONE place so postinstall, the CLI help path, and any test
 * that pins the copy all read the same bytes — no drift between the three
 * surfaces the spec requires it on.
 *
 * The tools URL is shown BARE (no https://), per Bob. `xlsx-for-ai.dev/#tools`
 * is the live all-tools section on the homepage.
 */

const TOOLS_URL = 'xlsx-for-ai.dev/#tools';

// Column-aligned so the three action lines read as a table in a terminal. Kept
// as an explicit array (not a template block) so a test can assert each line
// independently and a copy edit is a one-line diff.
const ORIENTATION_LINES = [
  'You can use xfa to access xlsx-for-ai.',
  `See all tools:  ${TOOLS_URL}`,
  'Send feedback:  xfa feedback "<your message>"',
  'Get support:    xfa support "<your email>" "<your question>"',
];

function orientationText() {
  return ORIENTATION_LINES.join('\n');
}

/**
 * Print the block via the given writer (defaults to stdout). postinstall passes
 * a stderr writer so the block rides the same stream as the registration line
 * npm surfaces; the CLI help path uses stdout. A blank line is emitted before
 * the block so it separates cleanly from a preceding registration line.
 */
function printOrientation(write = (m) => process.stdout.write(m)) {
  write('\n' + orientationText() + '\n');
}

module.exports = { TOOLS_URL, ORIENTATION_LINES, orientationText, printOrientation };
