'use strict';

/**
 * First-run anonymous registration with the xlsx-for-ai hosted API.
 *
 * POST /api/v1/clients  { client_version, platform }
 *   -> { client_id, api_key }
 *
 * Writes result to config and returns { client_id, api_key }.
 * Idempotent: if config already has api_key, returns it immediately.
 *
 * CI gate: when running in a CI environment (CI=true, GITHUB_ACTIONS=true,
 * or XLSX_FOR_AI_CI=1) we skip registration entirely. This stops automated
 * smoke tests + clean-install verifications from polluting the production
 * client_id pool with synthetic per-publish UUIDs that don't represent
 * real human users.
 */

const os = require('os');
const { readConfig, mergeConfig } = require('./config');
const { apiBase, post } = require('./client');
const { version } = require('../package.json');

function platform() {
  return `${process.platform}-${process.arch}`;
}

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

async function ensureRegistered() {
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
  const body = { client_version: version, platform: platform() };
  const data = await post('/api/v1/clients', body, { auth: false });
  mergeConfig({
    client_id: data.client_id,
    api_key: data.api_key,
    registered_at: new Date().toISOString(),
  });
  return { client_id: data.client_id, api_key: data.api_key };
}

module.exports = { ensureRegistered, isCiEnvironment };
