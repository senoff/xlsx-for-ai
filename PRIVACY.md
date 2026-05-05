# Privacy

**Last updated:** 2026-05-05

This document covers how xlsx-for-ai handles your data. It is written for developers who want to audit the data flow before deploying xlsx-for-ai in an agent, and for FP&A teams who need to forward it to legal before using an agent that touches financial spreadsheets.

---

## Architecture

xlsx-for-ai is a thin npm client over a hosted API. When your agent calls a tool (e.g., `xlsx_read`), the client reads the file from disk, encodes it as base64, and sends it to the xlsx-for-ai API over HTTPS. Processing happens in memory on the server. The result is returned to your agent.

This means: **workbook bytes leave your machine and travel to our server for every non-fallback tool call.** If that is not acceptable for your threat model, use the offline fallback described below.

---

## What we send

For every tool call, the client sends:

- **File bytes** (base64-encoded) — the xlsx file your agent asked to process.
- **Anonymous client_id** — a UUID generated locally on first run. Not linked to an email address, name, or any identifying information.
- **Platform and version** — e.g., `darwin-arm64`, `2.0.0`. Used for compatibility telemetry.
- **Tool name and options** — which tool you called and the parameters you passed (sheet name, format, etc.).

We do not send or collect:

- Email address (we never ask for one).
- Cell content beyond what is in the file bytes during the request (the bytes are not stored after the request completes).
- File metadata beyond size and sheet count, which are captured for telemetry.
- File names or paths — the client sends bytes only; the local path never leaves your machine.

---

## What happens to the file bytes

File bytes are processed in memory. They are not written to disk on the server, not persisted to a database, and not stored in any cache beyond the duration of a single request.

**Audit log:** we log the following per request: timestamp, client_id, endpoint, file size (bytes), sheet count, error class (if any), latency, and which hardening checks ran. We do not log cell values, formula text, row data, or any representation of workbook content.

---

## Local fallback

`xlsx_read` includes a local fallback path. If the API is unreachable (network down, server error, timeout), the client reads the file using a locally installed engine (`@protobi/exceljs`, an optional dependency). In this case, nothing leaves your machine. The fallback is automatic and transparent; you can observe it in the client's stderr output.

All other tools (`xlsx_diff`, `xlsx_write`, `xlsx_redact`) require API connectivity and have no local fallback.

---

## Anonymous UUID registration

On first run, the client generates a UUID locally and sends it to `POST /api/v1/clients` with your platform and client version. The server returns an opaque API key. Both are stored in `~/.xlsx-for-ai/config.json`.

The UUID is anonymous by design. We do not ask for an email address, phone number, or any other identifying information. The UUID is a random identifier — it cannot be traced back to you without your cooperation.

**To delete your registration:** remove the config file.

```bash
rm ~/.xlsx-for-ai/config.json
```

The next tool call will generate a new UUID and register a new client. Your previous usage history (audit log entries) will remain associated with the old UUID, but the old UUID cannot be linked to the new one or to you.

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

## Audit log retention

Server-side audit logs (request metadata, not workbook content) are retained for **90 days**, then deleted. This is our current policy; we will update this document if the retention period changes.

---

## Compliance posture

**SOC 2:** not yet certified. We operate with SOC 2-aligned controls (access logging, least-privilege service accounts, encrypted storage at rest, TLS in transit) and are working toward formal certification.

**GDPR:** we do not collect personally identifiable information. The client_id UUID is not linked to any natural person. If you believe a UUID is linked to you and want it deleted from our audit logs, contact us at the address below and we will delete all records for that client_id within 30 days.

**HIPAA / PCI:** xlsx-for-ai is not HIPAA- or PCI-certified. Do not use it to process protected health information or payment card data in regulated environments without additional controls.

---

## Data deletion requests

To request deletion of your audit log records: email `privacy@xlsx-for-ai.dev` with your client_id (found in `~/.xlsx-for-ai/config.json`). We will delete all audit log entries for that client_id within 30 days and confirm by reply.

---

## Changes to this document

Material changes will be noted in [CHANGELOG.md](CHANGELOG.md) with the date they take effect.
