'use strict';

/**
 * Notices the package shows in its own words, wherever the person is.
 *
 * The service marks a response when the kind of key this install uses (made
 * before sign-in with Google) will stop being accepted. Those marks are headers,
 * and no host shows headers, so the package turns the fact into one sentence of
 * its own. It deliberately does NOT repeat the service's text: that text names a
 * date and terminal steps, and no date is promised for any cutoff.
 *
 * Where the person is decides the step:
 *   - in an app or editor (the MCP server): nothing to do now; when the key stops
 *     working a sign-in link is shown in the same place;
 *   - in a terminal: the one command that switches now.
 */

const SUNSET_NOTICE_MCP =
  'Heads up from xlsx-for-ai: this computer is signed in with an older kind of key, and the service has said it will stop accepting those. ' +
  'Nothing needs doing now. When it stops working, a sign-in link (sign in with Google) will appear right here, and one approval keeps everything working.';

const SUNSET_NOTICE_CLI =
  'xlsx-for-ai: this computer is signed in with an older kind of key, and the service has said it will stop accepting those. ' +
  'To switch now, run `xlsx-for-ai login --force` and sign in with Google.';

/**
 * Adds a note as one more text block at the end of a tool result, leaving the
 * result's own text and `_meta` untouched. Returns the result (or the input as
 * is when it has no content list to add to).
 */
function appendNotice(result, text) {
  if (!text || !result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}

module.exports = { SUNSET_NOTICE_MCP, SUNSET_NOTICE_CLI, appendNotice };
