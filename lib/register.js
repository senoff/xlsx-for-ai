'use strict';

/**
 * First-run anonymous registration with the xlsx-for-ai hosted API.
 *
 * POST /api/v1/clients  { client_version, platform }
 *   -> { client_id, api_key }
 *
 * Writes result to config and returns { client_id, api_key }.
 * Idempotent: if config already has api_key, returns it immediately.
 */

const os = require('os');
const { readConfig, mergeConfig } = require('./config');
const { apiBase, post } = require('./client');
const { version } = require('../package.json');

function platform() {
  return `${process.platform}-${process.arch}`;
}

async function ensureRegistered() {
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

module.exports = { ensureRegistered };
