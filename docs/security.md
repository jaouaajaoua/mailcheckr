# Security

Implements PRD §10. This document states what is actually in place and — equally important — what is known-open (see also `RISK-REGISTER.md`).

## 1. SMTP worker network safety (SSRF prevention)

The highest-risk surface: the worker connects outbound based on DNS answers derived from user-supplied domains.

- Only connect to mail-exchanger hosts derived from the target address's own domain. **Never** accept an arbitrary host or port from an API caller.
- Resolve, then validate the **final IP** immediately before connecting (mitigates DNS rebinding / TOCTOU): block loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), multicast, reserved ranges, and cloud metadata addresses (`169.254.169.254` and equivalents). The blocklist is a pure function in `packages/core`, unit-tested against literal ranges, because the build sandbox's synthetic DNS (see `phase-0-audit.md`) makes live testing meaningless there.
- Hard connect/read/write timeouts; bounded retries only for transient outcomes; per-domain, per-MX, per-account, and global concurrency caps.
- The SMTP conversation is EHLO → STARTTLS (**required** before the target address is transmitted; failure ⇒ `unknown`, no cleartext fallback) → EHLO → MAIL FROM (controlled probe identity only) → RCPT TO → RSET → QUIT. **DATA is never issued** — an automated test with a fixture SMTP server fails the build if it ever is. No VRFY/EXPN enumeration. Catch-all probing: one synthetic random recipient per domain per 24 h maximum.
- Status today: Deep mode is **disabled** (ADR-006), so this surface is not yet live; the resolver-side IP validation and its tests exist ahead of it, and the connect-path checks land with Phase 5.

## 2. Tenant isolation

- Every tenant-owned row carries `workspace_id`; every service query is workspace-scoped; cross-workspace IDs return `404`.
- Covered by explicit cross-tenant tests (Workspace A cannot read, export, cancel, or delete Workspace B's batches, results, keys, or ledger).
- Audit events record actor, action, resource type/ID with minimised metadata — never raw keys, passwords, or email lists.

## 3. Credentials

- **Passwords:** Argon2id hashes only.
- **API keys:** CSPRNG-generated `mc_live_…` secrets, shown once, stored as a keyed hash with a server-side pepper (`API_KEY_PEPPER`); prefix stored for display; revocation is immediate; `last_used_at` tracked. Keys never travel in query strings and are redacted from logs (secret-redaction tests).
- **Dashboard sessions:** JWT (HS256, `JWT_SECRET` ≥ 32 chars, 1 h default lifetime) in `localStorage` — a recorded trade-off with a pre-launch migration to HttpOnly SameSite cookies + CSRF (ADR-010, R-15). Compensations: strict CORS allowlist (no wildcards), CSP + security headers, no third-party scripts on authenticated pages.

## 4. Customer data protection

- Email values encrypted at rest (AES-256-GCM, ADR-007); HMAC digests (separate key) for dedupe — never unsalted plain hashes, never plaintext in Redis job payloads (IDs only) or logs.
- No training on customer data; no sale/sharing/repurposing of uploaded lists.
- No GDPR/compliance marketing claims without legal review (R-14).

### 4.1 Retention defaults (configured, not just documented)

| Data | Default retention | Config | Applied by |
|---|---|---|---|
| Raw uploaded source file/object | **24 hours** after successful processing | `SOURCE_RETENTION_DAYS=1` | Scheduler expiry job |
| Verification results + batch rows | **7 days** | `RESULT_RETENTION_DAYS=7` | Scheduler expiry job |
| Credit ledger | Retained (accounting record; references batch IDs, contains no email content) | — | — |
| Operational logs | Minimised metadata only (see §4.3) | platform log retention | Logging pipeline |
| Backups | 14 days; deletions propagate as backups age out | backup policy | `runbooks/db-restore.md` |

The workspace's values in force are readable at `GET /v1/account/settings` and are displayed live on the dashboard Settings page (which labels the PRD defaults as defaults if the endpoint is unreachable — it never presents defaults as a read-back).

### 4.2 Verified deletion flow

1. **Request** — dashboard batch delete / Settings "delete all my batch data" / `DELETE /v1/batches/:id` / account deletion `DELETE /v1/account` (full procedure: `runbooks/data-deletion.md`).
2. **Execute** — batch, rows, results, source and export objects are deleted in one service operation; account deletion invalidates sessions immediately and schedules workspace erasure.
3. **Verify** — the deleted IDs return `404` from the API (including the export endpoint), object-storage keys are confirmed absent, and an audit event records the deletion (resource IDs only, no content). The Settings delete control reports the number of batches actually deleted.
4. **Disclose the exception** — data inside backups persists until backups age out (14 days); after any restore, pending deletions are re-applied before traffic reopens.

### 4.3 Log redaction policy

- Structured logs may contain: `request_id`, `workspace_id`, `batch_id`, stage, reason codes, counts, durations.
- Logs must **never** contain: plaintext email addresses (use the HMAC digest prefix or the domain only), API keys or their secrets, passwords or password hashes, JWTs, full CSV contents, or raw SMTP transcripts beyond minimised response codes.
- Enforced by logger configuration (redaction paths for `authorization`, `password`, `secret`, `api_key` fields) plus secret-redaction tests in the security suite; error responses use the standard envelope and never leak stack traces (see `docs/api.md`).

## 5. CSV and file handling

- Streaming parser; file-size, row-count (10,000), and MIME limits; uploads are data, never executed (no macros/formula evaluation).
- **CSV formula injection:** every exported cell whose value begins with `=`, `+`, `-`, `@`, tab, or CR is escaped (prefixed) so exported files are safe to open in spreadsheet applications; covered by unit tests.
- Email-column detection is heuristic with manual override; parse failures are reported per row, never silently dropped, and are not charged.

## 6. Application security baseline

- TLS everywhere in production; HSTS + CSP + `X-Content-Type-Options` etc. via the web/API tiers.
- Per-user and per-API-key rate limiting; request-size limits; API-key brute-force resistance via hashing + rate limits.
- Input validation with Zod contracts on every endpoint; error envelope never leaks stack traces or SMTP transcripts.
- Dependency audit, secret scanning, and container scanning in the Phase 8 hardening pass; no public admin routes; admin actions audited.
- Secrets live only in `.env`/secret manager — `.env.example` contains placeholders only, and `.env` is git-ignored and docker-ignored.

## 7. Known-open items (honest list)

| Item | Status |
|---|---|
| HttpOnly cookie dashboard sessions + CSRF (replacing localStorage JWT) | Pre-launch follow-up (ADR-010) |
| SMTP connect-path SSRF checks | Land with Phase 5, which is gate-blocked (ADR-006) |
| External penetration test | Phase 8, before public launch |
| Legal review of privacy notice / DPA / terms | Open (R-14) |
