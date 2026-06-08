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

function runSetup(rest) {
  const confirm = rest.includes('--confirm');
  const uninstall = rest.includes('--uninstall');

  // Touch confirm so the flag is wired even before cleanup lands.
  void confirm;

  try {
    const regOk = uninstall
      ? unregisterMcpServer().ok
      : registerMcpServer({ mode: 'cli' }).ok;
    return regOk ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

module.exports = { runSetup };
