# Test Report

**Rule (PRD §13/§14):** a feature is not "completed" until its acceptance tests have actually run and passed. This report records *observed* results only. Anything not executed is marked **PENDING / CI-PENDING** — never inferred from code inspection.

_Last updated: 2026-11-10 — final reconciliation pass (web ↔ API contract alignment, compiled-package packaging, plain-Node boot proof, `next build`)._

## 1. Environment

| Suite | Environment |
|---|---|
| Unit / fixture integration | Muse sandbox VM: Ubuntu 24.04.5, Node v24.22.1, pnpm 9.15.0. No Docker, no local Postgres/Redis, proxy-only HTTP egress, system DNS refuses MX (`EREFUSED`) — see `phase-0-audit.md`. |
| API boot proof | Same sandbox, API compiled to `dist/` and started with plain `node dist/main.js` (no tsx), in-memory repository (no `DATABASE_URL`). |
| Web build | Same sandbox, `apps/web` (`next build`, Next.js 15.5.29). |
| Full-stack (Postgres/Redis/containers) | **CI-PENDING** — requires the GitHub Actions services or a Docker host. |
| CI (GitHub Actions) | **Workflow hardened 2026-11-10, awaiting first run.** `.github/workflows/ci.yml` launches real `postgres:16` + `redis:7` service containers with health checks; runs Prisma validate/generate, creates a dedicated `mailcheckr_integration` database owned by the DB integration tests (they drop/recreate its schema and apply the init migration themselves), runs `prisma migrate deploy` against the separate `mailcheckr_test` database, typechecks, runs unit suites, then the DB and queue **integration** steps with a guard that fails the job if either gated suite reports as skipped; finally `next build`, all three Docker image builds, and `ci-reports/` artifact upload. (The previous workflow's `test:integration`/`test:e2e` steps invoked pnpm scripts that no package defines — silent no-ops — and have been replaced with direct vitest invocations.) |

> **Evidence rule for DB/queue integration:** the local sandbox has no Docker, PostgreSQL, or Redis, so **CI is the designated evidence** for database and queue integration. DB/queue integration must **not** be claimed complete from local runs or code inspection — only from a green CI run of the integration/E2E steps above (or an equivalent staging run), recorded here with its date and run link.
>
> **Prisma CLI in the sandbox:** `prisma validate` / `prisma generate` cannot run here — the `@prisma/engines` binaries were never downloaded (postinstall blocked by proxy-only egress) and the CLI's network calls are reset (`ECONNRESET`). Schema validation and client generation are therefore **CI-PENDING**. The hand-written migration SQL (including `20261110010000_batch_name_and_ledger_retention`) is reviewed but unexecuted until CI/staging.

## 2. Final verified totals (2026-11-10, this pass)

| Package | Command | Result |
|---|---|---|
| `@mailcheckr/core` | `pnpm --filter @mailcheckr/core test` | ✅ **188 passed** (7 files) |
| `@mailcheckr/contracts` | `pnpm --filter @mailcheckr/contracts test` | ✅ **7 passed** |
| `@mailcheckr/datasets` | `pnpm --filter @mailcheckr/datasets test` | ✅ **4 passed** |
| `@mailcheckr/config` | `pnpm --filter @mailcheckr/config test` | ✅ **7 passed** (incl. `API_PORT` default now 4000) |
| `@mailcheckr/api` | `pnpm --filter @mailcheckr/api test` | ✅ **50 passed, 4 skipped** (9 files; previously 42+4 — +8 new reconciliation tests, §5) |
| `@mailcheckr/worker` | `pnpm --filter @mailcheckr/worker test` | ✅ **14 passed, 1 skipped** |
| **Total** | | ✅ **270 passed, 5 skipped, 0 failed** (skips are the DB/Redis-gated integration suites, §4) |
| TypeScript | `tsc --noEmit` in contracts, datasets, config, core, api, worker, web | ✅ All clean |
| TypeScript | `tsc --noEmit` in `packages/database` | ❌ Pre-existing sandbox failure: `@prisma/client` has no generated client (`PrismaClient` not exported) because `prisma generate` cannot run here (above). Not a code regression; **CI-PENDING**. |
| Web production build | `next build` in `apps/web` | ✅ **Passed** — compiled in 9.1s, 12/12 pages generated, exit 0 |
| Package builds | `pnpm --filter @mailcheckr/{contracts,datasets,core,api,worker} build` | ✅ All produce `dist/` (see §6) |
| API plain-Node boot | `node apps/api/dist/main.js` (API_PORT=4000) | ✅ Boots; 22 routes mapped under `/v1` + `GET /health`; register → 201, unauthenticated → 401 envelope, old `/auth/*` → 404 |

## 2b. Pre-CI local run (2026-11-10, GitHub push preparation)

Full local suite re-run immediately before the first GitHub push, with
`DATABASE_URL`/`REDIS_URL` unset (so the gated integration suites self-skip
locally, exactly as designed — CI must execute them against real services):

| Package | Command | Result |
|---|---|---|
| `@mailcheckr/contracts` | `pnpm --filter @mailcheckr/contracts test` | ✅ **7 passed** |
| `@mailcheckr/datasets` | `pnpm --filter @mailcheckr/datasets test` | ✅ **4 passed** |
| `@mailcheckr/config` | `pnpm --filter @mailcheckr/config test` | ✅ **7 passed** |
| `@mailcheckr/core` | `pnpm --filter @mailcheckr/core test` | ✅ **188 passed** |
| `@mailcheckr/api` | `pnpm --filter @mailcheckr/api test` | ✅ **59 passed, 4 skipped** (skips = DB-gated integration suite; +9 OpenAPI tests since §2) |
| `@mailcheckr/worker` | `pnpm --filter @mailcheckr/worker test` | ✅ **14 passed, 1 skipped** (skip = Redis-gated queue suite) |
| **Total** | | ✅ **279 passed, 5 skipped, 0 failed** |
| Web typecheck | `apps/web`: `tsc --noEmit` | ✅ exit 0 |
| Typecheck | `tsc --noEmit` in contracts, datasets, config, core, api, worker | ✅ All clean |
| Typecheck | `packages/database` | ❌ Still fails locally (no generated Prisma client — sandbox cannot run `prisma generate`). The hardened CI workflow now runs `prisma generate` **before** typecheck, so this is expected to pass in CI; remains **CI-PENDING** until observed. |

CI status at this run: `.github/workflows/ci.yml` **hardened, awaiting first
run** — real `postgres:16` + `redis:7` services, Prisma
validate/generate/migrate-deploy, a dedicated integration database
(`mailcheckr_integration`, owned by the DB tests which drop/recreate its
schema and apply the init migration themselves; the Prisma-migrated
`mailcheckr_test` is separate), skip-guards that fail the job if either
gated suite reports as skipped, `next build`, all three Docker image
builds, and `ci-reports/` artifact upload. **A green CI run is still
required before DB/queue integration may be claimed.**

## 3. Verification core — unit tests (PRD §13.1)

Covered by the 188 passing `@mailcheckr/core` tests plus contracts/datasets suites: syntax/normalisation edge cases, IDN→Punycode, SMTPUTF8-unsupported handling, duplicate normalisation, role/disposable/free-provider lookup, Null MX and implicit-MX fallback rules, DNS failure taxonomy (NXDOMAIN vs SERVFAIL vs REFUSED vs TIMEOUT — infrastructure failures never classify as `invalid`), SMTP response parsing incl. enhanced codes (generic 550 → `unknown`, definitive 5.1.1 → `invalid`), classification for every status + reason code, SSRF IP blocklist (private/loopback/link-local/multicast/reserved/metadata, peer-IP verification), catch-all matrix, credit-chargeability rules, CSV formula-injection escaping, and the **DATA-command prohibition** tests (fixture transports assert DATA is never issued; STARTTLS-missing aborts before RCPT).

## 4. Integration tests (PRD §13.2, controlled fixtures only)

Fixture-level integration (fake DNS/SMTP, in-memory repositories) runs and passes inside the suites in §2, including worker crash/restart idempotency and batch duplicate + credit reconciliation at the processor/service level.

**Real Postgres/Redis integration: CI-PENDING.** The DB integration suite (`apps/api/test/integration/db.integration.test.ts`, 4 skipped locally) and the worker queue integration suite (1 skipped locally) self-skip without `DATABASE_URL`/`REDIS_URL` and activate in CI, where real `postgres:16` + `redis:7` services run and migrations are applied first. No green CI run has been recorded yet, so database/queue integration is **not** claimed complete. Live Gmail/Microsoft/Yahoo checks are **not** used in CI by design.

## 5. End-to-end / contract tests (PRD §13.3)

HTTP-level flows run against the real NestJS+Fastify app (in-memory repository, controlled DNS fixtures) in `apps/api/test/http.test.ts` (10 tests) plus the reconciliation suite added in this pass, `apps/api/test/reconciliation.test.ts` (8 tests):

- Register → login via **`/v1/auth/*`**; the old unversioned `/auth/*` paths return 404.
- Auth responses carry `access_token` (+ legacy `accessToken` alias) and `user.workspace_id`, matching `apps/web/lib/api.ts`.
- `GET /v1/auth/me` → current user + workspace; unauthenticated → 401.
- `GET /v1/verifications` → persisted single checks, newest first; workspace B sees none of A's (tenant isolation).
- `GET /v1/batches` → workspace batches newest first with `name`, row/unique/duplicate/completed counts, `credits_charged`, `created_at`; tenant-isolated. Batch creation now persists the `name` sent per PRD §8.3.
- `GET /v1/usage` exposes the documented fields (`plan_code`, `credits_reserved`, `checks_this_month`, `period_start/end`) alongside the previous ones.
- `GET /v1/account/settings` → live retention (`source_retention_hours: 24`, `result_retention_days: 7` from config), plan, credits summary reconciled to the ledger (100 − 4 charges = 96 in the test scenario).
- `DELETE /v1/account` → wrong confirmation `422`; API-key auth `403`; with confirmation (and with no body, the dashboard's exact request) the purge is verified at the repository level: user, workspace, batches, records and API keys gone; **ledger entries retained with amounts intact and batch/record links severed**; audit event written; old session/API key/login all rejected afterwards; the other workspace untouched.
- Single Quick result, Deep-mode gate-off behaviour (`smtp_port_unavailable`, never `valid`), API-key lifecycle, batch dedupe/export/cancel, batch delete purge, 1000-email JSON cap (413), per-workspace rate limiting (429 + `retry_after_seconds`).

Browser E2E (Playwright) against the full Compose stack: **PENDING** — requires a Docker host.

## 6. Packaging / runtime verification

`@mailcheckr/contracts`, `@mailcheckr/datasets` and `@mailcheckr/core` previously shipped TypeScript-source `main` (`src/index.ts`), which plain Node cannot execute. They now build with `tsc -p tsconfig.build.json`:

| Package | `main` / `types` | Notes |
|---|---|---|
| contracts | `dist/index.js` / `dist/index.d.ts` | rootDir `src` |
| datasets | `dist/src/index.js` / `dist/src/index.d.ts` | rootDir `.` so the versioned JSON data is emitted to `dist/data/` alongside |
| core | `dist/index.js` / `dist/index.d.ts` | build typechecks against the siblings' `dist` typings |

Tests still run from source via the existing Vitest aliases (`packages/core/vitest.config.ts`, and now also `apps/api/vitest.config.ts`); `apps/api` typechecks against sources (`tsconfig.json` paths) and builds against `dist` typings (`tsconfig.build.json` paths). `infra/docker/Dockerfile.api` and `Dockerfile.worker` build contracts → datasets → core before the app build. Boot proof (§2) confirms `node dist/main.js` resolves the compiled packages through pnpm workspace links with no tsx in the path.

## 7. Security tests (PRD §13.4)

Passing within the suites in §2: SSRF/IP-blocklist unit coverage (private/loopback/link-local/multicast/reserved/metadata ranges, DNS-rebinding/peer-IP checks), API-key rate-limit behaviour, auth/session checks, CSV parser/DoS limits (413 cap, formula-injection escaping), cross-tenant authorisation (404-not-403 on other tenants' batches; list endpoints tenant-scoped), secret redaction (API-key secrets never appear in list responses; password/reset-token hashes verified). Account deletion via API key is refused (403) — new in this pass.

## 8. Network gate (PRD §6)

| Check | Result |
|---|---|
| MX resolution from build sandbox (gmail.com / example.com / outlook.com) | ❌ `EREFUSED` from system resolver (198.19.0.1); direct 8.8.8.8 queries time out |
| TCP/25 from build sandbox | ❌ Not attemptable — proxy-only HTTP egress, no direct route |
| Provider approval / PTR / stable egress IP | ❌ None exist |
| **Verdict** | **Deep SMTP BLOCKED** — `SMTP_DEEP_ENABLED=false`, `SMTP_EGRESS_APPROVED=false` (see `phase-0-audit.md`); unchanged in this pass |
| `scripts/smtp-gate-check.mjs` on a real candidate host | **PENDING** — by definition cannot be satisfied from the sandbox |

## 9. How to update this report

Run the suite, paste the real summary (command, environment, pass/fail counts), flip the row from PENDING, and date the change. Never mark a row passed from code reading alone.
