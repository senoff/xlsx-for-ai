'use strict';

/**
 * HTTP client for the xlsx-for-ai hosted API.
 *
 * Base URL: XLSX_FOR_AI_API env var || https://api.xlsx-for-ai.dev
 *
 * post(path, body, opts)         — POST JSON, returns parsed response body
 * callTool(toolName, body)       — POST /api/v1/tools/<toolName> with auth
 *
 * 15s per-attempt timeout, up to 3 attempts (45s ceiling). On retry the
 * AbortController for the prior attempt has already fired, so any
 * keep-alive socket undici held on the failing attempt is released
 * before the retry opens a fresh one. Surfaces phase timing to stderr
 * for production-incident diagnosis (SPM P1 2026-06-06: hosted tool
 * calls timing out in Claude Desktop — server saw ~200ms responses
 * but client saw 2-4 minute round-trips; the gap is in the connection
 * dial / IPC layer, observability captures which next time).
 */

const { readConfig } = require('./config');
const { version: CLIENT_VERSION } = require('../package.json');

const DEFAULT_API = 'https://api.xlsx-for-ai.dev';
// Per-attempt timeout. Was 30s pre-3.0.7. Tighter so a stuck dial
// (IPv6 black hole, stale keep-alive) fails fast and the retry path
// reopens a fresh socket. 3 attempts × 15s = 45s ceiling, well under
// Claude Desktop's 60s client-side initialize timeout AND under the
// MCP tools/call timeout class.
const TIMEOUT_MS  = 15_000;
const MAX_ATTEMPTS = 3;

function apiBase() {
  return (process.env.XLSX_FOR_AI_API || DEFAULT_API).replace(/\/$/, '');
}

// Stderr structured timing log. stdout is the MCP transport in the
// mcp-server context; never write timing data there.
function emitTiming(toolPath, attempt, phase, elapsedMs, extra) {
  // One-line JSON so future log-shipper can grep / parse. Kept compact
  // to stay inside Claude Desktop's MCP log buffer.
  const obs = {
    t: 'xlsx-for-ai-mcp.timing',
    path: toolPath,
    attempt,
    phase,
    elapsed_ms: Math.round(elapsedMs),
  };
  if (extra) Object.assign(obs, extra);
  try {
    process.stderr.write(JSON.stringify(obs) + '\n');
  } catch (_) {
    // EPIPE on stderr is swallowed by the mcp.js top-level guard;
    // here we just no-op so a missing log sink doesn't break the call.
  }
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
  const headers = {
    'Content-Type': 'application/json',
    'X-Client-Version': CLIENT_VERSION,
  };

  if (opts.auth !== false) {
    const cfg = readConfig();
    if (cfg && cfg.api_key) headers['Authorization'] = `Bearer ${cfg.api_key}`;
  }

  // Privacy opt-out: XFA_PRIVACY=strict env var (or per-call override) adds
  // X-XFA-Privacy: strict to every request, preventing error-triggered capture.
  if (process.env.XFA_PRIVACY === 'strict' || opts.privacyStrict) {
    headers['X-XFA-Privacy'] = 'strict';
  }

  const requestStart = Date.now();
  const jsonBody = JSON.stringify(body);
  // Byte length (UTF-8), not code-unit length — multi-byte chars in the
  // body would otherwise be undercounted in observability.
  const bodyBytes = Buffer.byteLength(jsonBody, 'utf8');
  // `attempt: -1` is the convention for non-attempt-scoped events
  // (per-request setup / teardown); keeps the 1..MAX_ATTEMPTS scope
  // unambiguous in log analysis.
  emitTiming(path, -1, 'send', 0, { body_bytes: bodyBytes });

  let res;
  let lastErr;
  let winningAttempt = -1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStart = Date.now();
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: jsonBody,
      });
      const attemptElapsed = Date.now() - attemptStart;
      emitTiming(path, attempt, 'response-headers', attemptElapsed, {
        status: res.status,
      });
      lastErr = null;
      winningAttempt = attempt;
      break;
    } catch (err) {
      lastErr = err;
      const attemptElapsed = Date.now() - attemptStart;
      const errName = err && err.name ? err.name : 'Unknown';
      const errCode = err && err.code ? err.code : null;
      emitTiming(path, attempt, 'attempt-failed', attemptElapsed, {
        error_name: errName,
        error_code: errCode,
      });
      // No sleep between retries — let the underlying socket pool refresh
      // on the next fetch call. A sleep would just lengthen the total
      // wait and the SPM-evidenced symptom is already a dial stall that
      // a fresh socket fixes.
    }
  }

  if (!res) {
    const totalElapsed = Date.now() - requestStart;
    emitTiming(path, MAX_ATTEMPTS, 'all-attempts-failed', totalElapsed);
    const e = new Error(`xlsx-for-ai API unreachable: ${lastErr ? lastErr.message : 'unknown'}`);
    e.code = 'API_UNREACHABLE';
    throw e;
  }

  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch (_) { payload = null; }
    // Prefer the structured `{code, message}` shape our server emits; the
    // top-level `error` / `message` fall-back keeps the older surfaces
    // working. `payload.error` could be an OBJECT — coerce to .message
    // first to avoid stringifying [object Object].
    const errField = payload?.error;
    const msg = (errField && typeof errField === 'object' ? errField.message : errField)
      || payload?.message
      || res.statusText;
    const totalElapsed = Date.now() - requestStart;
    emitTiming(path, winningAttempt, 'http-error', totalElapsed, { status: res.status });
    const e = new Error(`xlsx-for-ai API error ${res.status}: ${msg}`);
    e.status = res.status;
    e.payload = payload;
    e.code = res.status >= 500 ? 'API_SERVER_ERROR' : 'API_CLIENT_ERROR';
    throw e;
  }

  const json = await res.json();
  const totalElapsed = Date.now() - requestStart;
  emitTiming(path, winningAttempt, 'body-complete', totalElapsed);
  return json;
}

async function callTool(toolName, body) {
  return post(`/api/v1/tools/${toolName}`, body);
}

module.exports = { apiBase, post, callTool };
