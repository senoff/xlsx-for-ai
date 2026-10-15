# Privacy

**Last updated:** 2026-10-14

This document covers how xlsx-for-ai handles your data. It is written for developers who want to audit the data flow before deploying xlsx-for-ai in an agent, and for FP&A teams who need to forward it to legal before using an agent that touches financial spreadsheets.

---

## Architecture

xlsx-for-ai is a thin npm client over a hosted API. When your agent calls a tool (e.g., `xlsx_read`), the client reads the file from disk, encodes it as base64, and sends it to the xlsx-for-ai API over HTTPS. Processing happens in memory on the server. The result is returned to your agent.

This means: **workbook bytes leave your machine and travel to our server for every tool call.** They are processed in memory and not retained beyond the request, but if any workbook data leaving your machine is unacceptable for your threat model, xlsx-for-ai is not the right fit for those files.

---

## What we send

For every tool call, the client sends:

- **File bytes** (base64-encoded) — the xlsx file your agent asked to process.
- **client_id** — an identifier issued when you sign in. From version 4.1.0 it is linked to the account you sign in with (email link or Google). Keys created by earlier versions are anonymous and not linked to an email address.
- **Platform and version** — e.g., `darwin-arm64`, `2.0.0`. Used for compatibility telemetry.
- **Tool name and options** — which tool you called and the parameters you passed (sheet name, format, etc.).

We do not send or collect:

- Email address in tool calls. Sign-in (version 4.1.0 and later) does store the email of the account you sign in with, encrypted; see [Sign-in and registration](#sign-in-and-registration). The only tool-side exception is `xfa support`, which sends the email you type as a reply-to; see [Feedback and support](#feedback-and-support).
- Cell content beyond what is in the file bytes during the request (the bytes are not stored after the request completes).
- File metadata beyond size and sheet count, which are captured for telemetry.
- File names or paths — the client sends bytes only; the local path never leaves your machine.

---

## What happens to the file bytes

File bytes are processed in memory. In normal (non-error) requests, they are not written to disk on the server, not persisted to a database, and not stored in any cache beyond the duration of a single request.

**In one sentence:** Files are processed for your request and not stored; upload handles and download links expire after 60 minutes; file contents are not logged or used for training.

**Temporary copies through the MCP connector:** a file uploaded through the one-time upload page is kept under a file handle, and a file a tool produces is kept so you can download it. Each is deleted after 60 minutes, and a download link serves only the account that produced it. The request header `X-XFA-Privacy: strict` (CLI flag `--privacy=strict`, or environment variable `XFA_PRIVACY=strict`) turns off the download copy.

**No capture.** Workbook capture is off for every account (since 2026-10-14). We do not keep copies of workbooks, redacted or not, when a request fails or succeeds. Error reports sent to our error tracker carry the error type and our own code's stack trace, never the error message text.

**No training.** Your files and their contents are not used to train models.

**When part of a file goes to an AI model.** A few tools ask an AI model (Anthropic's Claude API) for help and send it only the part of the file that job needs: `xlsx_pii_scan` and `xlsx_redact` send short candidate text strings to find names and addresses; the Shopify import tools and the import converter send column headers and a few sample values per column to match columns to the target format. No other tool sends file contents to anyone, except tools you point at a destination (such as `xlsx_post_slack` or `xlsx_post_teams`), which send what you ask them to send.

**Audit log:** we log the following per request: timestamp, client_id, endpoint, file size (bytes), sheet count, structural fingerprints (formula count, sheet dimensions, feature flags like "uses_LAMBDA"), error class (if any), latency, and which hardening checks ran. We do not log cell values, formula text, row data, or any representation of workbook content.

---

## Sign-in and registration

From version 4.1.0 the client signs in with the OAuth device flow: `xlsx-for-ai login` prints a link, you approve it in a browser (email link or Google), and the server issues an API key bound to that account via `POST /api/v1/clients`. The key and client ID are stored in `~/.xlsx-for-ai/config.json`. The email address is stored encrypted and used only to identify the account. No password is stored.

Versions before 4.1.0 registered anonymously: the server issued a random client ID and key with no email or other identifying information. Those keys keep working during the transition; the server marks their responses with a sunset notice naming the cutoff date.

**To sign out on a machine:** remove the config file. The next use will ask you to sign in again.

```bash
rm ~/.xlsx-for-ai/config.json
```

---

## Telemetry

Telemetry is opt-in and disabled by default. When enabled, we capture aggregate usage signals (call counts, error rates, file size distributions) tied to your client_id. No workbook content is captured in telemetry.

```bash
xlsx-for-ai --enable-telemetry    # opt in
xlsx-for-ai --disable-telemetry   # opt out (default)
xlsx-for-ai --telemetry-status    # check current setting
```

The telemetry setting is stored in `~/.xlsx-for-ai/config.json` under the `telemetry` key. It persists across upgrades.

---

## Feedback and support

Two optional commands send a message to us. Neither sends any workbook content.

- **`xfa feedback "<message>"`** — anonymous. Your message is stored tied only to your anonymous client_id; we do not ask for or send an email address.
- **`xfa support "<email>" "<question>"`** — the email you type is transmitted and stored as the reply-to so we can answer you. It is used only to reply to your question.

Both run only when you invoke them; nothing is sent otherwise.

---

## Audit log retention

Server-side audit logs (request metadata, not workbook content) are retained for **90 days**, then deleted. This is our current policy; we will update this document if the retention period changes.

---

## Consent level

Workbook capture is off for every account, whatever its consent level, so the level no longer affects capture. Setting it to `none` still matters for one thing: it is the same as sending `X-XFA-Privacy: strict` on every request, which turns off the 60-minute download copy:

```bash
curl -X PATCH https://api.xlsx-for-ai.dev/api/v1/clients/me/consent \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"capture_consent_level": "none"}'
```

---

## Compliance posture

**SOC 2:** not yet certified. We operate with SOC 2-aligned controls (access logging, least-privilege service accounts, encrypted storage at rest, TLS in transit) and are working toward formal certification.

**GDPR:** the only personal data we hold is the email address of the account you sign in with (stored encrypted, used only to identify the account). Keys created before version 4.1.0 are anonymous. If you want your records deleted from our audit logs, contact us at the address below and we will delete all records for that client_id within 30 days.

**HIPAA / PCI:** xlsx-for-ai is not HIPAA- or PCI-certified. Do not use it to process protected health information or payment card data in regulated environments without additional controls.

---

## Data deletion requests

To request deletion of your audit log records: email `hello@xlsx-for-ai.dev` with your client_id (found in `~/.xlsx-for-ai/config.json`) and "privacy request" in the subject line. We will delete all audit log entries for that client_id within 30 days and confirm by reply.

---

## Changes to this document

Material changes will be noted in [CHANGELOG.md](CHANGELOG.md) with the date they take effect.
