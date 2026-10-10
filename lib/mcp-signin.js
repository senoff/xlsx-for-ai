'use strict';

/**
 * Sign-in for the MCP server, which runs under a desktop app or editor with no
 * terminal.
 *
 * With no stored key, the first tool call starts the same device login that
 * `xlsx-for-ai login` uses and answers with the sign-in link and short code.
 * The poll keeps running in the background; once the user approves, the key is
 * stored exactly as `xlsx-for-ai login` stores it, so the next tool call just
 * works with no restart.
 *
 *   - One device request at a time: a repeat call while sign-in is pending gets
 *     the same link and code back.
 *   - A code that expired, was declined or failed is dropped, so the next call
 *     starts a fresh one.
 *   - Never reads stdin, never writes stdout (stdout is the JSON-RPC channel),
 *     never runs at start-up: tools/list answers with no key.
 */

const { isCiEnvironment } = require('./register');
const { hasStoredKey } = require('./config');
const login = require('./login');

// Unref'd so a pending sign-in never keeps the server alive after the host
// closes the connection.
const unrefSleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (t.unref) t.unref();
});

function createMcpSignIn(deps = {}) {
  const start = deps.startDeviceRequest || login.startDeviceRequest;
  const poll = deps.pollDeviceLogin || login.pollDeviceLogin;
  const stored = deps.hasStoredKey || hasStoredKey;
  const isCi = deps.isCiEnvironment || isCiEnvironment;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || unrefSleep;
  const log = deps.log || ((s) => { try { process.stderr.write(s + '\n'); } catch (_) { /* no log sink */ } });

  let pending = null;   // { link, code, expiresAt, notice } while a sign-in is waiting
  let starting = null;  // promise for a device request that is in flight
  let lastFailure = null; // one short sentence: why the last sign-in did not finish

  async function begin(notice) {
    const req = await start();
    const ttlMs = (Number(req.expiresIn) || 900) * 1000;
    const entry = {
      link: req.verificationUriComplete || req.verificationUri,
      code: req.userCode,
      expiresAt: now() + ttlMs,
      // Why this is a fresh link: the last sign-in was declined, ran out, or
      // could not be saved; or the saved key was turned down.
      notice: [lastFailure, notice].filter(Boolean).join(' '),
    };
    lastFailure = null;
    pending = entry;
    // Detached on purpose. Whatever the outcome, this entry is dropped so the
    // next call either sees the stored key or starts a fresh code. A failure is
    // remembered so the next answer can say what happened before the new link.
    poll(req, { sleep, now }).then(
      () => { if (pending === entry) pending = null; },
      (err) => {
        if (pending === entry) pending = null;
        lastFailure = failureSentence(err);
        log(`xlsx-for-ai-mcp: sign-in ended (${(err && err.code) || 'error'})`);
      }
    );
    return entry;
  }

  /**
   * Resolves to null when the tool call may go ahead (CI skip or a stored key).
   * Otherwise resolves to { link, code, expiresAt, notice } for the sign-in to show.
   * Rejects with a LOGIN_FAILED error only when the sign-in service could not be
   * reached or refused the request.
   */
  async function check() {
    if (isCi()) return null;
    if (stored()) return null;
    if (pending && pending.expiresAt > now()) return pending;
    pending = null;
    if (!starting) starting = begin().finally(() => { starting = null; });
    return starting;
  }

  /**
   * The server turned down the stored key (a 401). Offer a fresh sign-in link on
   * this same request. The stored key is left alone until a new one is saved:
   * approval overwrites it, a failed sign-in does not take it away. Resolves to
   * null in an automated run, where there is no person to sign in.
   */
  async function offerAfterRejection() {
    if (isCi()) return null;
    if (pending && pending.expiresAt > now()) return pending;
    pending = null;
    if (!starting) starting = begin(REJECTED_NOTICE).finally(() => { starting = null; });
    return starting;
  }

  return { check, offerAfterRejection };
}

const REJECTED_NOTICE = 'The sign-in saved on this computer was not accepted by xlsx-for-ai, so it needs to be done again.';

// One short sentence saying why the last sign-in did not finish.
function failureSentence(err) {
  switch (err && err.reason) {
    case 'declined': return 'The last sign-in was declined, so nothing was saved.';
    case 'expired': return 'The last sign-in link ran out of time before it was approved.';
    case 'not_issued': return 'You approved the last sign-in, but the service could not create your key, so you are not signed in yet.';
    case 'not_saved': return 'You approved the last sign-in, but the key could not be saved on this computer (the ~/.xlsx-for-ai folder may not be writable), so you are not signed in yet.';
    case 'unreachable': return 'The sign-in service stopped answering before the last sign-in finished.';
    case 'refused': return 'The sign-in service turned down the request, and asking again will not change that. Update xlsx-for-ai to the newest version, or report it at https://github.com/senoff/xlsx-for-ai/issues.';
    default: return 'The last sign-in did not finish.';
  }
}

function signInMessage(info, now = Date.now()) {
  const minutes = Math.max(1, Math.round((info.expiresAt - now) / 60000));
  const lead = info.notice
    ? [`${info.notice} Here is a new link to try again.`, '']
    : [];
  return [
    ...lead,
    'xlsx-for-ai is free, and it needs a one-time sign-in before it can work on your spreadsheet.',
    '',
    'Please show the user this message, including the link:',
    '',
    `1. Open this link in a browser: ${info.link}`,
    `2. Check that it shows the code ${info.code}, then approve.`,
    '3. Come back and ask again. The same request will work, with no restart.',
    '',
    `The link works for about ${minutes} minutes.`,
  ].join('\n');
}

const defaultSignIn = createMcpSignIn();

module.exports = {
  createMcpSignIn,
  signInMessage,
  failureSentence,
  checkSignIn: defaultSignIn.check,
  offerSignInAfterRejection: defaultSignIn.offerAfterRejection,
};
