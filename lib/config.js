'use strict';

/**
 * ~/.xlsx-for-ai/config.json — unified config for v2.0+
 *
 * Extends the v1.5.x telemetry config keys so upgrades are non-breaking.
 *
 * Full shape (all keys optional):
 * {
 *   "telemetry": true,
 *   "consented_at": "<ISO>",
 *   "consent_version": 1,
 *   "client_id": "<uuid>",
 *   "api_key": "<opaque>",
 *   "registered_at": "<ISO>"
 * }
 *
 * Uses XFA_CONFIG_DIR env var for test isolation (same as v1.5.x).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CURRENT_CONSENT_VERSION = 1;

function configDir() {
  return process.env.XFA_CONFIG_DIR || path.join(os.homedir(), '.xlsx-for-ai');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeConfig(data) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function mergeConfig(patch) {
  const existing = readConfig() || {};
  writeConfig({ ...existing, ...patch });
}

// --- telemetry helpers (preserved from v1.5.x) ---

function telemetryStatus() {
  const cfg = readConfig();
  if (!cfg) return 'not configured';
  if (cfg.telemetry === false) return 'disabled';
  if (cfg.telemetry === true) {
    if (cfg.consent_version !== CURRENT_CONSENT_VERSION) {
      return 'paused (consent_version mismatch)';
    }
    return 'enabled';
  }
  return 'not configured';
}

function isTelemetryActive() {
  return telemetryStatus() === 'enabled';
}

function enableTelemetry() {
  mergeConfig({
    telemetry: true,
    consented_at: new Date().toISOString(),
    consent_version: CURRENT_CONSENT_VERSION,
  });
}

function disableTelemetry() {
  mergeConfig({ telemetry: false });
}

module.exports = {
  CURRENT_CONSENT_VERSION,
  configPath,
  readConfig,
  writeConfig,
  mergeConfig,
  telemetryStatus,
  isTelemetryActive,
  enableTelemetry,
  disableTelemetry,
};
