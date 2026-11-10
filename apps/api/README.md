# @mailcheckr/api

NestJS + Fastify REST API (PRD §8). Real endpoints, no placeholders:

- `POST /auth/register|login|logout`, `POST /auth/password-reset/request|confirm`
  (reset tokens stored SHA-256-hashed; plaintext token returned only as
  `devResetToken` outside production — production delivery requires a mail
  provider integration; MailCheckr never sends email itself)
- `POST /v1/verifications` — Quick mode; Deep requested with the gate off
  returns the capped likely_valid/unknown path with `smtp_port_unavailable`
- `POST /v1/batches` (JSON ≤1000, deduped, credits reserved for uniques),
  `GET /v1/batches/:id`, `GET /v1/batches/:id/results` (cursor),
  `POST /v1/batches/:id/cancel`, `POST /v1/batches/:id/export` (CSV),
  `DELETE /v1/batches/:id`
- `GET /v1/usage`, `GET /v1/credits/ledger`
- `POST|GET /v1/api-keys`, `DELETE /v1/api-keys/:id` — secret shown once,
  stored as HMAC-SHA256 digest + prefix only

Auth: JWT (HS256) for sessions, `mc_live_` API keys for programmatic access.
workspace_id always comes from the verified credential. Error envelope:
`{ error: { code, message, request_id, retry_after_seconds? } }`.

Persistence: Prisma/PostgreSQL when `DATABASE_URL` is set
(`PrismaRepository`), otherwise the in-memory implementation of the same
`Repository` contract (tests/dev sandbox). Batch processing runs inline in
this API-only runtime; in production the identical settlement logic runs in
apps/worker via BullMQ.

Verification uses `src/verification/local-contracts.ts` as a temporary
fallback until `@mailcheckr/contracts` / `@mailcheckr/core` land; the
service is structured to swap to `verifyQuick` from core.

Run: `npm test` (Vitest), `npm run dev`, `npm start` after `npm run build`.

## Privacy, retention, resource protection

- Stored emails: AES-256-GCM ciphertext (`src/common/crypto.ts`) + keyed
  HMAC dedupe digest. Logs must pass through `redactForLog`
  (`src/common/redact.ts`) — emails masked, `mc_live_` secrets and
  password/token fields redacted.
- Retention: `RETENTION_DAYS` env (default 7). `RetentionService.purgeExpired`
  expires batches and deletes their records; `DELETE /v1/batches/:id` is a
  verified purge (records/rows removed, ledger links severed — ledger amounts
  kept for accounting, audit event `batch.purge` written).
- Rate limits (per workspace, env-configurable): single checks
  `RATE_LIMIT_SINGLE_PER_MIN` (default 60/min); batch creates
  `RATE_LIMIT_BATCH_PER_HOUR` (default 5/hour) → 429 `RATE_LIMITED`.
- Size limits: JSON body 1 MB (Fastify `bodyLimit`); JSON batch >1000 emails
  → 413 `PAYLOAD_TOO_LARGE`.
- DNS taxonomy: infrastructure DNS failures (SERVFAIL/REFUSED/TIMEOUT) from
  @mailcheckr/core surface as `unknown` + `dns_temporary_failure`, never
  `invalid`, and are never charged.

## Running the compiled build

`@mailcheckr/core` currently ships a TypeScript-source entry
(`main: src/index.ts`), so the API runs under `tsx` (`pnpm dev`, or
`tsx src/main.ts`). `pnpm build` typechecks/emits `dist/`, but plain
`node dist/main.js` cannot load core until core publishes a compiled dist —
tracked as a packaging follow-up for the core package.

## Integration tests (real services, CI)

`test/integration/db.integration.test.ts` runs only when `DATABASE_URL`
points at a real PostgreSQL (`describe.skipIf`): it applies the init
migration and asserts real-DB tenant isolation, ledger idempotency
(unique-violation 23505), and `batch_rows` uniqueness. Locally these are
skipped — in-memory tests do NOT prove real-DB behaviour.
