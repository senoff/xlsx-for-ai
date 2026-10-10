'use strict';

// ---------------------------------------------------------------------------
// Shared 4xx inline-surface sanitizer + surfacer.
//
// Both the MCP path (mcp.js `friendlyErrorMessage`) and the CLI path
// (index.js `friendlyCliError`) need to turn an `API_CLIENT_ERROR` (4xx)
// into short, client-safe text that surfaces the server's validation
// message (the caller's own input shape — "Sheet \"X\" not found.
// Available sheets: ...", "spec.sheets must be an array") while scrubbing
// anything sensitive a wrapped 4xx path could carry. Lifted here so there
// is exactly ONE sanitizer — not a second, drifting fork per surface.
//
// 5xx / everything else stays generic and is handled by each caller; this
// module is 4xx-only.
// ---------------------------------------------------------------------------

// Defense in depth on the 4xx inline message. The SPEC's bet is that
// 4xx server messages describe the CALLER'S OWN INPUT (which field,
// what was expected) — but a wrapped 4xx path could still carry
// absolute file paths, emails, JWTs / Bearer tokens, Slack tokens,
// or other PII. Scrub those before surfacing, replace with `<…>`
// placeholders so the caller still sees the SHAPE of the message
// without the sensitive payload.
//
// `<…>` was picked over a more verbose `[redacted-x]` so it's
// visually compact and unambiguously not real input.
const PII_SCRUBBERS = [
  // Bearer / Authorization tokens — match before generic JWT pattern.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, '<bearer>'],
  // JSON Web Tokens. Three dot-separated base64url segments, the first
  // starting with `eyJ` (the canonical JWT header prefix).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>'],
  // Slack bot / user / app tokens.
  [/\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g, '<slack-token>'],
  // Our own API keys.
  [/\bxfa_[a-z]+_[A-Za-z0-9]{16,}\b/g, '<xfa-key>'],
  // Generic 32+ char hex (api keys / hashes).
  [/\b[a-f0-9]{32,}\b/gi, '<hex>'],
  // Emails.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // --- Absolute paths ---------------------------------------------------
  // The boundary between a path and the prose around it is genuinely ambiguous
  // (a filename may hold spaces, parens, punctuation), so we do NOT enumerate
  // delimiter characters — enumeration is unwinnable and every omitted char is
  // a leak. Instead BOTH ends are defined as the COMPLEMENT of a small closed
  // set. Two pass families (first match wins), covering POSIX, Windows drive,
  // and Windows UNC \\host\share:
  //
  //   A. EXTENSION-ANCHORED — ROOT-AGNOSTIC. A token ending in a file extension
  //      is unambiguously a filename, so no root allowlist is needed; any
  //      absolute path (any drive, any UNC host, any POSIX root — `/data`,
  //      `/srv/www`, whatever) is redacted. Boundaries, categorically:
  //        - EXTENSION `(?:\.[\p{L}\p{N}]{1,15})+` — one or more Unicode
  //          letter/number dotted segments (covers `.tar.gz` AND non-ASCII
  //          extensions; a trailing sentence period is then the terminator,
  //          not a dot inside the name).
  //        - RIGHT TERMINATOR `(?=$|[^\p{L}\p{N}])` — end-of-string, or ANY
  //          char that is not a Unicode letter/number. No nameable gap: every
  //          space / quote / bracket / `}` / `>` / punctuation terminates.
  //        - INNER `[^\r\n]*?` — excludes ONLY the newline. A quote is allowed
  //          INSIDE the path (filenames legally hold `'` — "O'Brien.xlsx"), so
  //          a quote in the name can no longer leak the tail; a quote AFTER the
  //          extension still terminates via the RIGHT rule above.
  //        - LEFT (POSIX only) `(?<![:/\p{L}\p{N}])` — the leading `/` is
  //          rejected ONLY when preceded by a URL marker (`:` or `/`) or a host
  //          char (letter/number), so `http://h/a/b.json` stays intact while
  //          `` `/x.csv` ``, `path=/x.csv`, `(/x.csv)` all match. Windows/UNC
  //          are self-anchored by `X:\` / `\\` and need no left guard.
  //      (`\p{}` + lookbehind need a modern engine; package.json pins
  //      node>=22, so both are always available.)
  //   B. EXTENSIONLESS. No extension to anchor on, so the end is unknowable and
  //      a root-agnostic leading-`/` would swallow arbitrary prose (any
  //      " /word"). B therefore STAYS anchored to a system-root allowlist and
  //      over-redacts greedily toward end-of-line — the safe default for a
  //      defense-in-depth PII net. The residual (an EXTENSIONLESS path under a
  //      NON-listed root) is the one deliberately-open seam: closing it means
  //      eating prose, and it is theoretical-only on a surface that never
  //      receives client filesystem paths. A design floor, not an oversight.
  //
  // A — extension-anchored, root-agnostic, Unicode-categorical boundaries:
  [/[A-Za-z]:\\[^\r\n]*?(?:\.[\p{L}\p{N}]{1,15})+(?=$|[^\p{L}\p{N}])/gu, '<path>'],   // Windows drive
  [/\\\\[^\r\n]*?(?:\.[\p{L}\p{N}]{1,15})+(?=$|[^\p{L}\p{N}])/gu, '<path>'],           // Windows UNC
  [/(?<![:/\p{L}\p{N}])\/[^\r\n]*?(?:\.[\p{L}\p{N}]{1,15})+(?=$|[^\p{L}\p{N}])/gu, '<path>'], // POSIX (any root)
  // B — extensionless, greedy to end-of-line (over-redact toward EOL):
  [/[A-Za-z]:\\[^\r\n]*/g, '<path>'],   // Windows drive
  [/\\\\[^\r\n]*/g, '<path>'],           // Windows UNC
  [/\/(?:Users|home|var|opt|tmp|etc|private|Volumes|Library|usr|mnt|srv)\/[^\r\n]*/g, '<path>'], // POSIX (system roots)
];

// Strip the well-known low-signal noise an inline 4xx surface message
// could carry: leading "xlsx-for-ai API error 4xx: " prefix from
// lib/client.js, scrub PII via PII_SCRUBBERS, bound the length so a
// pathological payload can't blow up the conversation log / CLI stderr.
const INLINE_4XX_MAX_LEN = 280;
function shapeInline4xxMessage(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/^xlsx-for-ai API error \d+:\s*/i, '').trim();
  for (const [pattern, replacement] of PII_SCRUBBERS) {
    s = s.replace(pattern, replacement);
  }
  if (s.length > INLINE_4XX_MAX_LEN) {
    s = s.slice(0, INLINE_4XX_MAX_LEN - 1) + '…';
  }
  return s;
}

// Pull the raw inline message out of a 4xx error. Prefer the structured
// `{error: {message}}` shape our server emits, fall through to the flat
// `message` / string `error`, finally the wrapped `err.message` (whose
// "API error 4xx:" prefix shapeInline4xxMessage strips).
function extractInline4xxRaw(payload, err) {
  let inline = '';
  if (payload && typeof payload === 'object') {
    const structured = payload.error;
    if (structured && typeof structured === 'object' && typeof structured.message === 'string') {
      inline = structured.message;
    } else if (typeof payload.message === 'string') {
      inline = payload.message;
    } else if (typeof payload.error === 'string') {
      inline = payload.error;
    }
  }
  if (!inline && err && typeof err.message === 'string') {
    inline = err.message;
  }
  return inline;
}

// Turn a 4xx (`API_CLIENT_ERROR`) error into the final client-safe line,
// prefixed by the caller's label (tool name on the MCP side, command
// prefix on the CLI side). Known specific statuses keep curated text
// (ordered first); the generic branch surfaces the sanitized server
// message; an empty/absent payload degrades gracefully — never
// `undefined`, never `[object Object]`.
// The server's upgrade link, if it sent one (`error.upgrade.url` on a 402). Only
// an https address on xlsx-for-ai.dev (or a subdomain) is passed on, and only its
// scheme, host and plain path: the query string and fragment are dropped, so a
// token or address riding on the link is never echoed to the screen or a log.
// Anything else yields '' and the caller shows the plans page instead.
const UPGRADE_HOST = /^(?:[a-z0-9-]+\.)*xlsx-for-ai\.dev$/i;
const UPGRADE_PATH = /^\/[A-Za-z0-9/_.-]{0,120}$/;
function extractUpgradeUrl(payload) {
  const candidates = [
    payload && payload.error && typeof payload.error === 'object' && payload.error.upgrade,
    payload && payload.upgrade,
  ];
  for (const u of candidates) {
    const raw = u && typeof u.url === 'string' ? u.url.trim() : '';
    if (!raw || raw.length > 500) continue;
    let parsed;
    try { parsed = new URL(raw); } catch (_) { continue; }
    if (parsed.protocol !== 'https:' || !UPGRADE_HOST.test(parsed.hostname)) continue;
    if (parsed.username || parsed.password || parsed.port) continue;
    const pathPart = UPGRADE_PATH.test(parsed.pathname) ? parsed.pathname : '';
    return `https://${parsed.hostname.toLowerCase()}${pathPart === '/' ? '' : pathPart}`;
  }
  return '';
}

// Seconds the server asked the caller to wait (`retry_after_seconds`), if any.
function extractRetrySeconds(payload) {
  const raw = payload && payload.error && typeof payload.error === 'object'
    ? payload.error.retry_after_seconds
    : payload && payload.retry_after_seconds;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

// "1 minute", "2 minutes": the unit takes an "s" unless the count is exactly 1.
function pluralUnit(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function describeWait(seconds) {
  if (seconds < 90) return pluralUnit(seconds, 'second');
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return pluralUnit(minutes, 'minute');
  return pluralUnit(Math.ceil(minutes / 60), 'hour');
}

// 402 (a free allowance or trial used up) and 429 (a limit): the server's own
// sentence is the truth, and a person at a limit needs its upgrade link and how
// long to wait. The fixed wording below is only for a server that sent no message.
function surfaceLimit(prefix, status, err) {
  const payload = err && err.payload;
  let message = shapeInline4xxMessage(extractInline4xxRaw(payload, err));
  // With no body from the server the client falls back to the bare HTTP status
  // text; that says nothing a person can use.
  if (/^(?:payment required|too many requests)\.?$/i.test(message)) message = '';
  const fallback = status === 402
    ? 'your free allowance is used up, so this needs a paid plan to continue.'
    : 'a usage limit was reached. Please wait a little and try again.';
  let text = `${prefix}: ${message || fallback}`;
  const wait = extractRetrySeconds(payload);
  if (status === 429 && wait && !/\b(?:second|minute|retry|try again)/i.test(message)) {
    text += ` Try again in ${describeWait(wait)}.`;
  }
  const url = extractUpgradeUrl(payload);
  if (url && !text.includes(url)) {
    text += `\nUpgrade: ${url}`;
  } else if (!url && status === 402) {
    text += '\nSee the plans at https://xlsx-for-ai.dev.';
  }
  return text;
}

// A 501 is the server saying "not built yet". Retrying will not change that, so
// say it, in the server's words. Any other 5xx stays generic: it can carry
// upstream internals.
function surface5xx(prefix, err) {
  if (Number(err && err.status) === 501) {
    const message = shapeInline4xxMessage(extractInline4xxRaw(err.payload, err));
    return `${prefix}: ${message || 'this is not supported yet. Trying again will not help.'}`;
  }
  return `${prefix}: API returned a server error — retry shortly.`;
}

function surface4xx(prefix, err) {
  // Coerce so a string status ("429") still hits the curated branches; a
  // missing/garbage status becomes NaN and falls through to the generic path.
  const status = Number(err && err.status);
  const payload = err && err.payload;

  if (status === 429 || status === 402) {
    return surfaceLimit(prefix, status, err);
  }

  const shaped = shapeInline4xxMessage(extractInline4xxRaw(payload, err));
  if (shaped) {
    return `${prefix}: ${shaped}`;
  }
  return `${prefix}: invalid request (no detail provided).`;
}

module.exports = {
  PII_SCRUBBERS,
  INLINE_4XX_MAX_LEN,
  shapeInline4xxMessage,
  extractInline4xxRaw,
  surface4xx,
  surface5xx,
  extractUpgradeUrl,
  describeWait,
  pluralUnit,
};
