'use strict';

/**
 * HTTP client for the xlsx-for-ai hosted API.
 *
 * Base URL: XLSX_FOR_AI_API env var || https://api.xlsx-for-ai.dev
 *
 * post(path, body, opts)         — POST JSON, returns parsed response body
 * callTool(toolName, body)       — POST /api/v1/tools/<toolName> with auth
 *
 * Retries once on network errors. Maps HTTP errors to structured Error objects.
 */

const { readConfig } = require('./config');

const DEFAULT_API = 'https://api.xlsx-for-ai.dev';
const TIMEOUT_MS  = 30_000;

function apiBase() {
  return (process.env.XLSX_FOR_AI_API || DEFAULT_API).replace(/\/$/, '');
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body, opts = {}) {
  const url = apiBase() + path;
  const headers = { 'Content-Type': 'application/json' };

  if (opts.auth !== false) {
    const cfg = readConfig();
    if (cfg && cfg.api_key) headers['Authorization'] = `Bearer ${cfg.api_key}`;
  }

  // Privacy opt-out: XFA_PRIVACY=strict env var (or per-call override) adds
  // X-XFA-Privacy: strict to every request, preventing error-triggered capture.
  if (process.env.XFA_PRIVACY === 'strict' || opts.privacyStrict) {
    headers['X-XFA-Privacy'] = 'strict';
  }

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    // One retry on network error
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err2) {
      const e = new Error(`xlsx-for-ai API unreachable: ${err2.message}`);
      e.code = 'API_UNREACHABLE';
      throw e;
    }
  }

  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch (_) { payload = null; }
    const msg = payload?.error || payload?.message || res.statusText;
    const e = new Error(`xlsx-for-ai API error ${res.status}: ${msg}`);
    e.status = res.status;
    e.payload = payload;
    e.code = res.status >= 500 ? 'API_SERVER_ERROR' : 'API_CLIENT_ERROR';
    throw e;
  }

  return res.json();
}

async function callTool(toolName, body) {
  return post(`/api/v1/tools/${toolName}`, body);
}

module.exports = { apiBase, post, callTool };
