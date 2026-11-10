# MailCheckr

**Explainable email verification with conservative results, reliable bulk processing, and a developer-friendly API.**

MailCheckr tells you what is known, what is risky, and what cannot be verified about an email address — every result carries the checks performed, stable reason codes, a qualitative confidence label, and a plain-language explanation. It never sends email, and it never claims a mailbox was verified when it wasn't.

> **Mode availability (honest status):** Quick mode (syntax + risk signals + DNS/MX) is the shipping product. **Deep SMTP mode is BLOCKED and disabled**: outbound TCP/25 could not be tested or approved from the build environment, and no production provider approval exists yet. See `docs/phase-0-audit.md` for the evidence and the path to enabling it. There are no accuracy guarantees and no 0–100 scores anywhere in this product — by design (PRD §4).

## Stack

Next.js (App Router) + React · NestJS + Fastify · BullMQ workers · PostgreSQL 16 + Prisma · Redis 7 · TypeScript throughout · pnpm monorepo · Docker Compose.

## Quickstart

### With Docker Compose

```bash
cp .env.example .env        # fill in every change-me value (see docs/deployment.md §4)
docker compose up -d postgres redis
docker compose run --rm api pnpm --filter @mailcheckr/database exec prisma migrate deploy
docker compose up -d --build
```

- Dashboard: http://localhost:3000
- API: http://localhost:4000/v1 — contract in `docs/api.md`, live examples at http://localhost:3000/docs/api

### Without Docker

Requires Node.js 22, pnpm 9.15, and local PostgreSQL 16 + Redis 7:

```bash
pnpm install --frozen-lockfile
pnpm --filter @mailcheckr/database exec prisma migrate deploy
pnpm --filter @mailcheckr/api start    # terminal 1
pnpm --filter @mailcheckr/worker start # terminal 2
pnpm --filter @mailcheckr/web dev      # terminal 3 → http://localhost:3000
```

### First steps in the product

1. Register at `/register` — a workspace and a provisional free credit grant (100) are created.
2. Run a single check at `/dashboard/check`, or a bulk batch at `/dashboard/batches` (paste a list or choose a CSV — it's read as text in your browser and sent to `POST /v1/batches`).
3. Create an API key at `/dashboard/api-keys` (shown once) and call the API — examples in `docs/api.md`.

## Repository layout

```text
apps/web          Next.js dashboard (landing, auth, check, batches, API keys, settings, API docs)
apps/api          NestJS + Fastify REST API (/v1)
apps/worker       BullMQ workers (CSV, DNS, exports, expiry)
packages/core         verification pipeline: parse → risk → DNS → classify (SMTP gated)
packages/contracts    Zod schemas, status & reason-code enums
packages/database     Prisma schema + migrations
packages/config       typed env validation
packages/datasets     versioned disposable/role/free-provider datasets
infra/docker      Dockerfiles (api, worker, web)
docs/             architecture, API contract, security, decisions, risks, runbooks, test report
scripts/          smtp-gate-check.mjs — production-candidate port-25 gate probe
```

## Limits (resource protection)

Per-tenant rate limit **120 req/min** (per user and per API key) · daily verification ceiling 50,000 · uploads **≤ 5 MiB** · CSV batches **≤ 10,000 rows** · JSON batches **≤ 1,000 emails** · worker retry budget **3 attempts** (then terminal failure + credit release) · **per-domain concurrency throttle of 2**. All are env-configured (`RATE_LIMIT_*`, `MAX_UPLOAD_BYTES`, `MAX_CSV_ROWS`, `MAX_BATCH_JSON_EMAILS`, `WORKER_MAX_ATTEMPTS`, `PER_DOMAIN_CONCURRENCY`) and tabulated in `docs/api.md`.

## Documentation

| Doc | What it covers |
|---|---|
| `docs/phase-0-audit.md` | Environment audit + SMTP gate evidence and verdict |
| `docs/architecture.md` | System design, pipeline, bulk flow, credits, observability |
| `docs/api.md` | Full `/v1` contract, error envelope, charging rules |
| `docs/security.md` | SSRF defences, tenant isolation, key handling, CSV safety, known-open items |
| `docs/DECISIONS.md` | Architecture decision records |
| `docs/RISK-REGISTER.md` | Risks, mitigations, statuses |
| `docs/TEST-REPORT.md` | Observed test results — pending items are marked, never assumed |
| `docs/deployment.md` | Compose + manual deployment, secrets, the Deep-enablement gate |
| `docs/runbooks/` | SMTP block, Redis outage, DB restore, stuck batch, key compromise, data deletion |

## Phase matrix

| Phase | Scope | Status |
|---|---|---|
| 0 | Audit + SMTP gate | ✅ Complete — Deep **BLOCKED** with evidence |
| 1 | Monorepo foundation, Compose, CI | Built; container run pending a Docker host |
| 2 | DB, auth, tenancy, API keys | Built; acceptance tests pending full-stack run |
| 3 | Quick verification core | Built; fixture-tested design |
| 4 | Bulk CSV pipeline + credit ledger | Built; restart/idempotency integration pending |
| 5 | SMTP engine | ⛔ Blocked by Phase 0 gate — intentionally not implemented |
| 6 | REST API + developer docs | Built |
| 7 | UI polish + privacy controls | Built; web typecheck passes |
| 8 | Hardening + beta deployment | Not started |
| 9 | Billing + AppSumo readiness | Not started (pricing is an unvalidated hypothesis) |

Details and per-suite evidence: `docs/TEST-REPORT.md`.

## Non-negotiables honoured by this codebase

- No placeholder buttons or mock functionality: every dashboard control calls a real `/v1` endpoint or is absent/disabled with a stated reason (Deep mode).
- SMTP probing, when ever enabled, never issues `DATA` and never sends email — enforced by an automated fixture test.
- Duplicates and `unknown` results are never charged; all credit movement is an append-only, idempotent ledger.
- Customer addresses are encrypted at rest, HMAC-digested for dedupe, retained briefly (source 24 h, results 7 days), and deletable immediately.
