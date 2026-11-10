# MailCheckr — Phase Completion Report

_Last updated: 2026-11-10 (GitHub push preparation: secret scan clean, initial git commit created, CI workflow hardened — **CI status: workflow hardened, awaiting first run**; see TEST-REPORT §2b for the pre-CI local totals of 279 passed / 5 skipped / 0 failed). Statuses are honest per the PRD evidence rule: **COMPLETE** = acceptance tests actually ran and passed in the recorded environment; **CI-PENDING** = implemented and locally/fixture-verified, but the designated evidence (real Postgres/Redis in CI, Prisma client generation, Docker run) has not been observed yet; **BLOCKED** = cannot proceed without an external precondition; **DEFERRED** = intentionally postponed per PRD; **NOT STARTED** = no work done._

## Final verified test totals (2026-11-10)

| Suite | Result |
|---|---|
| `@mailcheckr/core` | 188 passed |
| `@mailcheckr/contracts` | 7 passed |
| `@mailcheckr/datasets` | 4 passed |
| `@mailcheckr/config` | 7 passed |
| `@mailcheckr/api` | 59 passed, 4 skipped (DB-gated) — +9 OpenAPI contract tests since the reconciliation row |
| `@mailcheckr/worker` | 14 passed, 1 skipped (Redis-gated) |
| **Total** | **279 passed, 5 skipped, 0 failed** (pre-CI local run, TEST-REPORT §2b) |
| Typecheck | `tsc --noEmit` clean: contracts, datasets, config, core, api, worker, web. `packages/database` fails in-sandbox for a pre-existing environmental reason (no generated Prisma client; see Phase 2) |
| Web build | `next build` ✅ passed (12/12 pages) |
| API runtime | `node apps/api/dist/main.js` ✅ boots on plain Node, 22 `/v1` routes + `GET /health` |

Environment for all local evidence: Muse sandbox VM (Ubuntu 24.04.5, Node v24.22.1, pnpm 9.15.0), no Docker/Postgres/Redis, proxy-only egress. Full evidence detail: `docs/TEST-REPORT.md`.

## Phase matrix

### Phase 0 — Repository and environment audit — ✅ COMPLETE
- Inspected runtimes/tools/network; ran MX-resolution and TCP/25 probes from the sandbox.
- **Verdict: Deep SMTP BLOCKED** — system DNS refuses MX (`EREFUSED`), direct DNS times out, HTTP egress is proxy-only, no provider approval/PTR/egress IP exists. Quick mode proceeded; Deep stayed disabled.
- Artifacts: `docs/phase-0-audit.md`, `docs/DECISIONS.md`, `docs/RISK-REGISTER.md`, `scripts/smtp-gate-check.mjs` (to run on a real candidate host — still PENDING there by definition).

### Phase 1 — Monorepo foundation — ✅ COMPLETE (local) / CI-PENDING (containers)
- pnpm workspace: `apps/{web,api,worker}`, `packages/{core,contracts,database,config,datasets}`; shared TS config; Docker Compose (Postgres 16, Redis 7, api, worker, web) and multi-stage Dockerfiles; GitHub Actions CI with real Postgres/Redis services.
- Reconciliation fix: the shared packages now compile to `dist/` (they previously shipped TS-source `main`, which plain Node and the Docker runtime could not execute); Dockerfiles build contracts → datasets → core before the app.
- Limitation: no Docker host in the sandbox — `docker compose up` and the image builds are **CI-PENDING**, never run locally.

### Phase 2 — Database, authentication, tenancy — 🟡 CI-PENDING
- Prisma schema + hand-written migrations for all PRD §7 tables; a follow-up migration (`20261110010000_batch_name_and_ledger_retention`) adds `verification_batches.name` and makes `credit_ledger.workspace_id` nullable/SET NULL so account purge can retain ledger amounts.
- Auth (bcrypt-hashed passwords, HS256 JWT sessions), one workspace per user, free-credit grant via ledger, API keys (shown once, HMAC-hashed, revocable, `last_used_at`), tenant scoping from the auth context only.
- Evidence: service + HTTP tests pass against the in-memory implementation of the same repository contract (auth, API-key, tenant-isolation suites green).
- Not yet evidenced: `prisma validate`/`generate` and the Postgres-backed repository against a real database — the Prisma engines binaries are unavailable in the sandbox, so both are **CI-PENDING**; `packages/database` typecheck fails locally for exactly this pre-existing reason.

### Phase 3 — Verification core (Quick) — ✅ COMPLETE
- Parser/normalisation (punycode, SMTPUTF8 guard), versioned seed datasets (disposable/role/free), DNS orchestration with the full failure taxonomy (NXDOMAIN / SERVFAIL / REFUSED / TIMEOUT distinguished; infrastructure failures never → `invalid`), Null MX, implicit-MX fallback, conservative explainable classification with every PRD reason code.
- Evidence: 188 core tests + 7 contracts + 4 datasets + 7 config, all passing, using controlled fake DNS/SMTP fixtures (no live network).
- `API_PORT` default aligned to **4000** in `packages/config` and `apps/api` config (matches compose, `.env.example`, and the web default).

### Phase 4 — Bulk CSV pipeline — ✅ COMPLETE (fixture level) / CI-PENDING (queue integration)
- Streaming CSV parsing in the worker, column inference, dedupe (duplicates never charged), persistent batch state, BullMQ processors that are idempotent and resumable, credit reserve/charge/release settlement with ledger idempotency, CSV export preserving rows with formula-injection escaping.
- Evidence: worker 14 passed/1 skipped; API batch HTTP flows (dedupe, export, cancel, delete-purge, reconciliation with the ledger) green.
- The skipped suite is the real-Redis queue integration test — **CI-PENDING**.

### Phase 5 — SMTP engine (conditional) — ⛔ BLOCKED
- Phase 0 gate failed (see Phase 0). Deep mode is **disabled in code and config** (`SMTP_DEEP_ENABLED=false`, `SMTP_EGRESS_APPROVED=false`; both must be true to enable). `mode:"deep"` returns the Quick classification capped at `likely_valid` with reason `smtp_port_unavailable` — never a fabricated `valid`.
- The core SMTP state machine exists as tested library code (EHLO → STARTTLS-required → MAIL FROM → RCPT → RSET → QUIT; SSRF IP validation with peer-IP verification; catch-all probe; **DATA is structurally forbidden** and fixture tests assert it is never issued), but no production worker enables it and no SMTP traffic leaves any deployment.
- Unblock requires: a real candidate host, `scripts/smtp-gate-check.mjs` passing there, and written provider approval.

### Phase 6 — REST API and developer docs — ✅ COMPLETE
- All `/v1` endpoints implemented and repository-backed: auth (register/login/logout/me/password-reset), single + batch verifications, batch results/cancel/export/delete, API keys, usage, credit ledger, account settings + deletion. Rate limits, idempotency keys, error envelope, prose docs in `docs/api.md`, examples in the web app at `/docs/api`.
- **Machine-readable OpenAPI 3.1 spec (this pass):** `docs/openapi.json` (20 paths / 24 operations — every route the API actually exposes, including `GET /health` and the spec endpoint itself), served live by the API at **`GET /v1/openapi.json`** (public, no credentials; static checked-in document served by `apps/api/src/openapi/openapi.controller.ts`, no swagger dependency added). Schemas reuse the `@mailcheckr/contracts` shapes: status enum (5, `duplicate` excluded — row-level only), reason-code enum (all 24), qualitative confidence, and the §8.6 error envelope; both auth schemes are declared (`bearerJwt`, `bearerApiKey` — `mc_live_…`). Deep mode is documented honestly as release-gated/**BLOCKED**: `mode:"deep"` returns Quick evidence capped at `likely_valid` with `smtp_port_unavailable`, never `valid`, while the gate is off. Drift guard: `apps/api/test/openapi.test.ts` (9 tests) derives the expected route set from the controller sources and asserts exact bidirectional coverage + enum equality with the contracts package; a mutation check (deleting `/v1/usage` from the spec) was run and correctly failed the suite (2 tests) before the spec was restored. API suite after this pass: **59 passed / 4 skipped** (was 50/4), `tsc --noEmit` clean.
- Reconciliation fixes in this pass (backend aligned to the contract the web already used):
  1. Auth controller moved `@Controller("auth")` → `@Controller("v1/auth")`; `main.ts` has no global prefix; tests updated. Auth responses now include `access_token` and `user.workspace_id` per `docs/api.md`.
  2. Implemented for real: `GET /v1/batches` (tenant-scoped, newest first, summary fields incl. persisted batch `name`), `GET /v1/verifications` (persisted single checks — POST already stored them with `batch_id` NULL — newest first, tenant-scoped), `GET /v1/auth/me`, `GET /v1/account/settings` (live retention from config, plan, credits summary), `DELETE /v1/account` (verified purge: batches/records/rows/API keys deleted, ledger entries retained with amounts and severed links, audit event, workspace + user deleted; requires a user session — API keys get 403; an optional `confirmation:"DELETE"` body is validated when sent — the dashboard gates client-side by typing DELETE and sends no body, which is accepted).
  3. `GET /v1/usage` now also returns the documented `plan_code`, `credits_reserved`, `checks_this_month`, `period_start/end`; added `GET /health` (the compose healthcheck target, previously missing).
  4. +8 HTTP tests in `apps/api/test/reconciliation.test.ts` covering every item above, including tenant isolation on both list endpoints and repository-level purge verification. API suite: **50 passed / 4 skipped**.
- Evidence: full HTTP suite green; plain-Node boot of the compiled API verified by curl (register 201, `/v1/auth/me`, `/v1/account/settings`, `/v1/batches` all correct; old `/auth/*` → 404).

### Phase 7 — UI polish and privacy controls — ✅ COMPLETE
- Next.js dashboard: overview (usage/recent checks/batches), single check, batches (create/list/detail/results/export), API keys, settings (live retention read-back, ledger, batch-data deletion, account deletion), API docs page. Every control calls a real endpoint; no placeholder buttons; Deep mode is visibly disabled with the gate explanation.
- Evidence: `tsc --noEmit` clean; **`next build` passed** in this pass (12/12 pages, exit 0). Playwright browser E2E against the Compose stack remains PENDING (needs a Docker host).

### Phase 8 — Hardening and beta deployment — 🟡 PARTIAL / CI-PENDING
- Done: security test coverage (SSRF blocklist, rebinding/peer-IP, tenant isolation, rate limits, CSV injection/DoS caps, secret redaction), retention/purge implementation + tests, log redaction helpers, runbooks (`docs/runbooks/`: smtp-block, redis-outage, db-restore, stuck-batch, key-compromise, data-deletion), deployment guide (`docs/deployment.md`), resource-protection limits (per-tenant rate limits, 1,000-email JSON cap, 10,000-row CSV cap, bounded retries, per-domain throttling).
- Not done / not evidenced: load/benchmark report against real providers, staging deployment on a Docker host, backup/restore drill, dependency/container scans in CI, beta-user evidence. **Not production-ready** until the CI integration/E2E runs are green and a staging deployment is exercised.

### Phase 9 — Billing and AppSumo readiness — ⬜ NOT STARTED
- No billing provider integrated (by design — provider selection requires business-entity/payout confirmation per PRD §9.3). Pricing remains an unvalidated hypothesis; no lifetime/unlimited plan exists. Credit packs, refunds, and AppSumo economics are future work.

## Commands executed in the reconciliation pass (evidence)

```bash
pnpm install -g pnpm@9.15.0                                   # toolchain (was absent in this shell)
pnpm --filter @mailcheckr/contracts build                     # ✅ dist/index.js
pnpm --filter @mailcheckr/datasets  build                     # ✅ dist/src/index.js + dist/data/*.json
pnpm --filter @mailcheckr/core      build                     # ✅ dist/index.js; plain-node require smoke test ✅
pnpm --filter @mailcheckr/api       build                     # ✅ dist/main.js (emits require("@mailcheckr/core"))
pnpm --filter @mailcheckr/worker    build                     # ✅ dist/main.js
API_PORT=4000 node apps/api/dist/main.js                      # ✅ boots; curl: /health, register 201, /v1/auth/me,
                                                              #    /v1/account/settings, /v1/batches, /auth/* 404
pnpm --filter @mailcheckr/{contracts,datasets,config,core,api,worker} test
                                                              # ✅ 270 passed / 5 skipped / 0 failed (totals above)
pnpm --filter @mailcheckr/{contracts,datasets,config,core,api,worker,web} typecheck
                                                              # ✅ clean (database package: pre-existing sandbox failure, Phase 2)
cd apps/web && next build                                     # ✅ 12/12 pages, exit 0
./node_modules/.bin/prisma validate                           # ❌ cannot run in sandbox (engines unavailable, ECONNRESET) → CI-PENDING
```

## Remaining limitations (explicit)

1. **Deep SMTP BLOCKED** — no port-25 evidence or provider approval exists; Quick mode only. Never substitute a third-party verification service.
2. **DB/Redis integration CI-PENDING** — Postgres/Prisma and BullMQ/Redis paths are implemented and fixture-verified, but no green CI or staging run has been observed; do not claim production readiness until then.
3. **Prisma validate/generate CI-PENDING** — CLI cannot run in this sandbox (missing engine binaries); migrations are hand-reviewed SQL.
4. **No Docker evidence** — Compose stack and Dockerfiles are written and internally consistent (including the compiled-package build order) but have never been built/run on a Docker host from this environment.
5. **Datasets are seed lists** — small in-repo curated lists with recorded source/license metadata, not licensed bulk datasets; coverage is limited by design.
6. **Password-reset delivery** — tokens are stored hashed and the flow is complete, but MailCheckr sends no email by design; production needs a transactional mail provider for reset delivery (dev token is returned only outside production).
7. **Billing (Phase 9) NOT STARTED** — credits are ledger-accounted but no payment provider, packs, or refunds exist.
8. **Account-deletion confirmation** — enforced in the dashboard UI (typing `DELETE`); the API validates `confirmation` when a caller sends it and requires an owner user session, but does not require a body (the dashboard sends none).

## Key artifact paths

- Source: `apps/api`, `apps/web`, `apps/worker`, `packages/{core,contracts,datasets,config,database}`
- New/changed in this pass: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/account/`, `apps/api/src/health/`, `apps/api/src/batches/`, `apps/api/src/verification/verifications.controller.ts`, `apps/api/src/usage/usage.controller.ts`, `apps/api/src/repositories/`, `apps/api/test/reconciliation.test.ts`, `packages/{contracts,datasets,core}/{package.json,tsconfig.build.json}`, `packages/database/prisma/migrations/20261110010000_batch_name_and_ledger_retention/`, `infra/docker/Dockerfile.{api,worker}`
- Docs: `docs/TEST-REPORT.md`, `docs/PHASE-REPORT.md`, `docs/phase-0-audit.md`, `docs/api.md`, `docs/architecture.md`, `docs/security.md`, `docs/deployment.md`, `docs/DECISIONS.md`, `docs/RISK-REGISTER.md`, `docs/runbooks/`
- Infra: `docker-compose.yml`, `infra/docker/Dockerfile.{api,worker,web}`, `.env.example`, `.github/workflows/ci.yml`
