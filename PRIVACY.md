# Privacy

**Last updated:** 2026-05-07

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

- Email address (tool calls and registration never ask for one — the only exception is if you choose to run `xfa support`, which sends the email you type as a reply-to; see [Feedback and support](#feedback-and-support)).
- Cell content beyond what is in the file bytes during the request (the bytes are not stored after the request completes).
- File metadata beyond size and sheet count, which are captured for telemetry.
- File names or paths — the client sends bytes only; the local path never leaves your machine.

---

## What happens to the file bytes

File bytes are processed in memory. In normal (non-error) requests, they are not written to disk on the server, not persisted to a database, and not stored in any cache beyond the duration of a single request.

**Error-triggered capture (optional, not currently enabled):** when a request results in an error (5xx, hardening rejection, or engine exception), we may retain a redacted copy of the workbook for up to 30 days, solely for debugging and improving the engine. "Redacted" means cell values are stripped before persistence — the same transform that `xlsx_redact` runs. Structure is preserved (formulas, named ranges, formatting, x14 features) so we can reproduce the failure, but your data is not stored. Captures auto-delete after 30 days via an R2 lifecycle rule.

This capture feature is **not currently enabled**. We will document the activation date in [CHANGELOG.md](CHANGELOG.md) when it is provisioned.

**Opt out of capture:** add the request header `X-XFA-Privacy: strict` to disable capture for a specific request. Use the CLI flag `--privacy=strict` to add this header to all requests from a CLI session, or set the environment variable `XFA_PRIVACY=strict` to opt out globally across all requests.

Captures are never used to train language models, never shared with third parties, and never used for any purpose other than diagnosing production errors.

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

## Capture consent levels

By default, captured workbook bytes are auto-redacted before persistence (cell values stripped, structure preserved — same transform as `xlsx_redact`). This is the `redacted_only` consent level.

Authenticated clients can change their consent level via `PATCH /api/v1/clients/me/consent`:

| Level | Description | Who can set it |
|---|---|---|
| `redacted_only` | Default. Auto-redact before any capture (cell values stripped, structure preserved). | Everyone |
| `none` | Opt out of all captures entirely. Equivalent to always sending `X-XFA-Privacy: strict`. | Everyone |

To change your consent level:

```bash
# Opt out of all captures
curl -X PATCH https://api.xlsx-for-ai.dev/api/v1/clients/me/consent \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"capture_consent_level": "none"}'

# Restore default (redacted captures only)
curl -X PATCH https://api.xlsx-for-ai.dev/api/v1/clients/me/consent \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"capture_consent_level": "redacted_only"}'
```

---

## Compliance posture

**SOC 2:** not yet certified. We operate with SOC 2-aligned controls (access logging, least-privilege service accounts, encrypted storage at rest, TLS in transit) and are working toward formal certification.

**GDPR:** we do not collect personally identifiable information. The client_id UUID is not linked to any natural person. If you believe a UUID is linked to you and want it deleted from our audit logs, contact us at the address below and we will delete all records for that client_id within 30 days.

**HIPAA / PCI:** xlsx-for-ai is not HIPAA- or PCI-certified. Do not use it to process protected health information or payment card data in regulated environments without additional controls.

---

## Data deletion requests

To request deletion of your audit log records: email `hello@xlsx-for-ai.dev` with your client_id (found in `~/.xlsx-for-ai/config.json`) and "privacy request" in the subject line. We will delete all audit log entries for that client_id within 30 days and confirm by reply.

---

## Changes to this document

Material changes will be noted in [CHANGELOG.md](CHANGELOG.md) with the date they take effect.
