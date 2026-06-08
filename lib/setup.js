'use strict';

/**
 * `setup` subcommand dispatch, shared by both bins (xlsx-for-ai and
 * xlsx-for-ai-mcp).
 *
 *   setup                       register the Claude Code MCP server +
 *                               dry-run cleanup report (deletes nothing)
 *   setup --cleanup --confirm   actually delete the dry-run-flagged artifacts
 *   setup --uninstall           remove the Claude Code entry + dry-run cleanup
 *   setup --uninstall --confirm remove the entry + actually delete artifacts
 *
 * Cleanup never deletes without --confirm. Registration (and entry removal on
 * --uninstall) is the explicit intent of the command, so it is not gated.
 */

const { registerMcpServer, unregisterMcpServer } = require('./mcp-register');
const { runCleanup } = require('./installer-cleanup');

function runSetup(rest) {
  // Cleanup runs as part of every setup/uninstall, but only DELETES with
  // --confirm; otherwise it prints a dry-run report. (--cleanup is accepted
  // as an explicit intent marker and is redundant with the default report.)
  const confirm = rest.includes('--confirm');
  const uninstall = rest.includes('--uninstall');

  try {
    const regOk = uninstall
      ? unregisterMcpServer().ok
      : registerMcpServer({ mode: 'cli' }).ok;
    const cleanupOk = runCleanup({ confirm }).ok;
    return regOk && cleanupOk ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

module.exports = { runSetup };
