'use strict';

/**
 * First-run sign-in for the xlsx-for-ai hosted API.
 *
 *   - A key already stored by this or an older version is used as-is.
 *   - No key + an interactive terminal: run the OAuth device login
 *     (see lib/login.js), print the verification URL, wait for approval.
 *   - No key + no terminal (an assistant's shell tool, a pipe, an editor task):
 *     print the link and code to stderr, wait a short while (60 seconds, or
 *     XFA_LOGIN_WAIT_SECONDS) for approval, and carry on if it comes. If not,
 *     fail with LOGIN_PENDING ("approve, then run the same command again"); the
 *     pending request is saved so the rerun resumes the same code.
 *   - XFA_NONINTERACTIVE=1: fail fast with LOGIN_REQUIRED instead.
 *     Never prompts on stdin.
 *
 * This version no longer mints anonymous keys.
 *
 * CI gate: when running in a CI environment (CI=true, GITHUB_ACTIONS=true,
 * or XLSX_FOR_AI_CI=1) we skip registration entirely. This stops automated
 * smoke tests + clean-install verifications from polluting the production
 * client_id pool with synthetic per-publish UUIDs that don't represent
 * real human users.
 */

const { readConfig } = require('./config');

// Detect common CI signals. Bias is toward FALSE POSITIVES on the CI side
// (a real user running with CI=true in their shell will get the same skip).
// Those cases are vanishingly rare, and the cost of a missed CI gate is much
// higher: polluted analytics + 1M MAU dilution.
function isCiEnvironment() {
  if (process.env.XLSX_FOR_AI_CI === '1') return true;
  // GitHub Actions auto-sets CI=true AND GITHUB_ACTIONS=true. Other major
  // providers also set CI=true (CircleCI, GitLab, Travis, Azure Pipelines,
  // BuildKite, Drone, Jenkins via plugin).
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  return false;
}

// `opts.signIn === false` means "only report whether a key is stored": the MCP
// server's start-up calls it that way, because start-up must never begin a
// sign-in on its own (the first tool call does, and answers with the link).
async function ensureRegistered(opts = {}) {
  if (isCiEnvironment()) {
    // Return a sentinel handle. api_key prefix 'xfa_ci_' is invalid format,
    // so any tool call would 401 with a clear "Invalid API key" rather than
    // silently using a leaked real key. CI smoke tests that only call
    // --version short-circuit before reaching this anyway.
    return {
      client_id: '00000000-0000-0000-0000-000000000000',
      api_key: 'xfa_ci_skip_registration',
      ci_skipped: true,
    };
  }

  const cfg = readConfig();
  if (cfg && cfg.api_key && cfg.client_id) {
    return { client_id: cfg.client_id, api_key: cfg.api_key };
  }
  if (opts.signIn !== false && isInteractive()) {
    const { deviceLogin } = require('./login');
    return deviceLogin();
  }
  // No terminal, and not an automated run: a person is behind this command (an
  // assistant's shell tool, a pipe, an editor task). Show the link and code,
  // wait a short while for approval, and if it has not come, remember the
  // request so running the same command again picks up where this left off.
  // XFA_NONINTERACTIVE=1 keeps the old fail-fast for people who ask for it.
  if (opts.signIn !== false && process.env.XFA_NONINTERACTIVE !== '1') {
    const { deviceLoginWithWindow } = require('./login');
    return deviceLoginWithWindow();
  }
  const e = new Error('xlsx-for-ai: not signed in. Run `xlsx-for-ai login`, then retry.');
  e.code = 'LOGIN_REQUIRED';
  throw e;
}

// Interactive = a human can open a browser: stdin AND stderr are TTYs, and we
// are not the MCP stdio server (stdin there is the JSON-RPC transport).
function isInteractive() {
  if (process.env.XFA_NONINTERACTIVE === '1') return false;
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

module.exports = { ensureRegistered, isCiEnvironment, isInteractive };
