# MailCheckr REST API — `/v1`

JSON request/response, versioned under `/v1`, schemas defined with Zod in `packages/contracts`.

**Machine-readable contract:** the OpenAPI 3.1 specification lives at **`docs/openapi.json`** in the repository (20 paths / 24 operations, covering every route below plus `GET /health`) and is served live by the API at **`GET /v1/openapi.json`** (public, no credentials required) — import that URL or file into Postman/Insomnia/code generators. Its enums are the `@mailcheckr/contracts` enums (verification statuses; all 24 reason codes) and its error shape is the §8.6 envelope below; a route-coverage test (`apps/api/test/openapi.test.ts`) fails CI if any controller route is missing from, or stale in, the spec. Interactive examples with copyable curl live in the web app at `/docs/api`.

## Conventions

- **Dashboard auth:** `Authorization: Bearer <JWT>` from `POST /v1/auth/login` / `register`.
- **Programmatic auth:** `Authorization: Bearer mc_live_<secret>`. Secrets are generated with a CSPRNG, shown **once** at creation, stored only as a keyed hash, rotatable/revocable, scoped. Never send keys in query strings.
- **Idempotency:** mutating verification/credit operations accept `idempotency_key`; retries with the same key return the original outcome instead of double-executing or double-charging.
- **Errors:** every error uses the envelope below. Raw SMTP transcripts and stack traces are never returned.
- **Tenant isolation:** every endpoint is scoped to the caller's workspace; cross-workspace IDs return `404` (not `403`, to avoid ID enumeration).

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Request rate limit exceeded.",
    "request_id": "req_...",
    "retry_after_seconds": 30
  }
}
```

Common codes: `VALIDATION_ERROR` (422), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `INSUFFICIENT_CREDITS` (402), `RATE_LIMITED` (429, with `retry_after_seconds`), `INTERNAL_ERROR` (500).

## Auth

### POST /v1/auth/register
```json
{ "email": "you@example.com", "password": "≥10 characters" }
```
→ `201 { "access_token": "…", "user": { "id", "email", "workspace_id" } }`. Creates the user and their single workspace, and grants the provisional free credits (ledger `grant` entry).

### POST /v1/auth/login
Same body → same response shape. Passwords verified against Argon2id hashes.

### POST /v1/auth/logout
Invalidates the presented session token. → `204`.

### GET /v1/auth/me
→ the session user `{ id, email, workspace_id, created_at }`.

### POST /v1/auth/password-reset/request
`{ "email" }` → always `200 { "ok": true }` (no account enumeration). The token is stored only as a hash. MailCheckr never sends email itself: delivery requires a transactional mail provider integration, so in non-production the response additionally carries `devResetToken` for local testing, and in production a provider must be configured to deliver the token — nothing is fake-sent.

## Verifications

### POST /v1/verifications
Scopes: `verifications:write`.
```json
{ "email": "person@example.com", "mode": "quick", "idempotency_key": "client-unique-key" }
```
`mode: "deep"` is release-gated and currently **BLOCKED** (Phase 0 gate, see `phase-0-audit.md`): until outbound TCP/25 is tested and provider-approved, a deep request returns the Quick (syntax/DNS/risk) classification **capped at `likely_valid` with reason code `smtp_port_unavailable`** — it is never simulated, never returns `valid`, and no SMTP traffic is sent. The OpenAPI spec (`docs/openapi.json`, `GET /v1/openapi.json`) documents the same behaviour.

Response (`200`):
```json
{
  "id": "ver_01...",
  "status": "likely_valid",
  "mode": "quick",
  "confidence": "medium",
  "email": "person@example.com",
  "domain": "example.com",
  "checks": { "syntax": "passed", "domain": "passed", "mx": "passed", "smtp_mailbox": "not_checked" },
  "reason_codes": ["smtp_not_attempted_quick_mode"],
  "explanation": "The address format and domain mail routing appear valid. The individual mailbox was not tested in Quick mode.",
  "checked_at": "2026-11-10T00:00:00Z"
}
```
Statuses: `valid | likely_valid | invalid | risky | unknown` (PRD §4.2). `valid` is only reachable in Deep mode with SMTP acceptance **and** a conclusive catch-all check. Confidence is qualitative (`high|medium|low`), never a probability.

### GET /v1/verifications?limit=10
Recent single checks for the workspace (newest first). → `{ "data": [ …verification results ] }`.

## Batches

### POST /v1/batches
Scopes: `batches:write`. JSON form (cap: **1,000 emails**; dashboard CSV cap: 10,000 rows):
```json
{ "name": "November contacts", "emails": ["one@example.com", "two@example.com"], "mode": "quick", "webhook_url": null, "idempotency_key": "batch-unique-key" }
```
→ `201` batch object with `status: "queued"`, row/unique/duplicate counts, and `credits_reserved`. Duplicates within the batch point at the canonical row and are not charged; `unknown` outcomes are not charged.

Large-file flow (P0 dashboard uses the JSON form above after reading the file client-side; the storage flow is the scale path): `POST /v1/uploads` → pre-signed URL + upload ID; upload CSV to object storage; `POST /v1/batches/from-upload` with the upload ID.

### GET /v1/batches?limit=50
List the workspace's batches (newest first).

### GET /v1/batches/:batchId
Batch status and counters:
```json
{
  "id": "…", "name": "November contacts", "source_type": "paste", "mode": "quick",
  "status": "processing",
  "row_count": 1200, "unique_count": 1150, "duplicate_count": 50, "completed_count": 640,
  "invalid_count": 0, "risky_count": 0, "unknown_count": 0,
  "credits_reserved": 1150, "credits_charged": 0, "credits_refunded": 0,
  "started_at": "…", "completed_at": null, "expires_at": "…", "created_at": "…", "updated_at": "…"
}
```
Statuses: `created | queued | processing | completed | completed_with_errors | failed | cancelled | expired`.

### GET /v1/batches/:batchId/results?status=&limit=&cursor=
Paged results. `status` ∈ `valid | likely_valid | invalid | risky | unknown | duplicate`. Each row: `{ id, row_number, email, status, confidence, reason_codes, explanation, is_duplicate, duplicate_of_row_number, checked_at }`. Original CSV columns and row order are preserved in exports (below).

### POST /v1/batches/:batchId/cancel
Cancels processing; unused reserved credits are released (ledger `release`). → updated batch.

### POST /v1/batches/:batchId/export
Body: `{ "statuses": ["valid", "likely_valid"] }` (omit/empty = all rows). Returns either the CSV stream (`text/csv`, `Content-Disposition: attachment`) or `{ "download_url": "…" }` for a pre-signed object-storage URL. Exports preserve every original column and the original row order, and cells are escaped against CSV formula injection.

### DELETE /v1/batches/:batchId
Deletes the batch, its rows, results, and stored source immediately (ahead of the retention schedule). → `204`.

## API keys

### GET /v1/api-keys
List: `{ id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at }`. Prefix only — secrets are unrecoverable by design.

### POST /v1/api-keys
```json
{ "name": "Production signup form", "scopes": ["verifications:write", "batches:write", "batches:read", "usage:read"] }
```
→ `201` key object **plus `secret` (full `mc_live_…`), returned exactly once**.

### DELETE /v1/api-keys/:id
Revokes the key immediately. → `204`.

## Usage & credits

### GET /v1/usage  (scope: `usage:read`)
```json
{ "workspace_id": "…", "plan_code": "free", "credits_balance": 87, "credits_reserved": 0, "credits_charged": 13, "checks_this_month": 13, "period_start": "…", "period_end": "…" }
```
Balance is derived from the ledger (ADR-008).

### GET /v1/credits/ledger?limit=50
Append-only entries: `{ id, entry_type, quantity, description, batch_id, created_at }`, `entry_type ∈ grant | reserve | charge | release | refund | purchase | adjustment`.

## Account

### GET /v1/account/settings
The workspace's settings as actually in force, including retention:
```json
{
  "workspace_id": "…",
  "plan_code": "free",
  "source_retention_hours": 24,
  "result_retention_days": 7
}
```
The dashboard Settings page renders these live values; it falls back to labelled product defaults only when this endpoint cannot be reached.

### DELETE /v1/account
Verified account purge (not a deferred request): requires a user session (API keys are refused with `403`); the dashboard gates it behind typing `DELETE`, and API callers may send `{ "confirmation": "DELETE" }` (validated when present). The call deletes the workspace's batches, verification records, batch rows and API keys, severs the credit ledger's links to batches/records while retaining the entries and amounts as the accounting record, writes an audit event, and deletes the workspace and the user. → `{ "status": "deleted", "batches_removed", "records_removed", "api_keys_removed", "ledger_entries_retained" }`. See `runbooks/data-deletion.md`.

## Webhooks (P1 — not in MVP)

Signed (`HMAC-SHA256` over raw body + timestamp) events `batch.completed`, `batch.failed`, `credits.low` with exponential-backoff retries. Documented here so integrators can plan; **not implemented in the MVP** and the `webhook_url` field is accepted-but-inert until P1 (it is never silently treated as live).

## Limits (resource protection)

Concrete, server-enforced limits — configured via the env vars in `.env.example` and pinned in `docker-compose.yml`:

| Limit | Value | Env var | Enforcement point |
|---|---|---|---|
| Per-tenant request rate (per user **and** per API key) | 120 requests/minute | `RATE_LIMIT_PER_MINUTE` | API middleware; `429` + `retry_after_seconds` |
| Per-tenant daily verification ceiling | 50,000/day | `RATE_LIMIT_VERIFY_PER_DAY` | Verification + batch creation |
| Upload size | **5 MiB** (`5,242,880` bytes) | `MAX_UPLOAD_BYTES` | Rejected before parsing |
| CSV batch size | **≤ 10,000 rows** | `MAX_CSV_ROWS` | Streaming parser; row cap aborts the import with an error, never a silent truncation |
| JSON batch size | **≤ 1,000 emails** per `POST /v1/batches` | `MAX_BATCH_JSON_EMAILS` | Request validation (`400 VALIDATION_ERROR`) |
| Worker retry budget | **3 attempts** per job, exponential backoff + jitter, then terminal failure | `WORKER_MAX_ATTEMPTS` | BullMQ job options; failed batches release reserved credits |
| Per-domain concurrency | **2** simultaneous verifications per recipient domain (and per MX host in Deep mode) | `PER_DOMAIN_CONCURRENCY` | Worker scheduler — protects remote servers and any future probe IP |
| Global worker concurrency | 10 per worker process | `WORKER_CONCURRENCY` | BullMQ worker options |

Limits exist to protect tenants from each other, remote mail servers from us, and the service from cost exhaustion (R-07/R-10). Raising them requires a deliberate config change, not a code default drift.
