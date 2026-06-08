'use strict';

/**
 * postinstall — register the MCP server into Claude Code (user scope) so a
 * fresh `npm i -g xlsx-for-ai` is wired without a manual config edit.
 *
 * Registration ONLY. Never runs cleanup (that always requires an explicit
 * `setup --cleanup --confirm`). Never throws — a failure here must not abort
 * `npm install`.
 *
 * Gated to global installs by a real user:
 *  - npm_config_global must be 'true' (don't touch config for local deps).
 *  - CI environments are skipped (no ~/.claude.json to wire, and we don't
 *    want synthetic registrations in clean-install verification).
 */

function isCi() {
  return (
    process.env.XLSX_FOR_AI_CI === '1' ||
    process.env.CI === 'true' || process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true'
  );
}

// `sudo npm i -g` runs this hook as root: registering then would write
// /root/.claude.json (or back up root's home), never the invoking user's
// config — silently misconfiguring the real account. Skip on elevation and
// let the user run `xlsx-for-ai setup` themselves as their normal user.
function isElevated() {
  try { if (process.getuid && process.getuid() === 0) return true; } catch (_) { /* no getuid (Windows) */ }
  return !!process.env.SUDO_USER;
}

function main() {
  if (process.env.npm_config_global !== 'true') return;
  if (isCi()) return;
  if (isElevated()) return;
  try {
    const { registerMcpServer } = require('../lib/mcp-register');
    registerMcpServer({ mode: 'postinstall' });
  } catch (_) {
    // Belt-and-suspenders: postinstall never throws.
  }
}

main();
