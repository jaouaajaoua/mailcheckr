# Architecture

Source of truth for product behaviour: the PRD (`MAILCHECKR_PRD_MUSE_SPEC.md`), especially §5 (architecture), §7 (data), §11 (reliability). Decisions and their rationale: `docs/DECISIONS.md`.

## 1. System overview

```text
 Browser ──HTTPS──► Web (Next.js, apps/web) ──REST /v1 (JWT / API key)──► API (NestJS+Fastify, apps/api)
                                                                               │            │
                                                              Postgres ◄─────────┘            ▼
                                                              (source of truth)        Redis + BullMQ
                                                                               ▲            │
                                                                               └──── Worker (apps/worker)
                                                                                     ├─ CSV parse / dedupe
                                                                                     ├─ DNS verification (Quick)
                                                                                     ├─ (gated) SMTP probing
                                                                                     └─ Exports, expiry jobs
 Object storage (S3-compatible): temporary source CSVs and export files
```

- **Web** serves the dashboard and public pages. It never runs verification itself; every control calls the REST API (`NEXT_PUBLIC_API_URL`, default `http://localhost:4000`).
- **API** validates input (Zod contracts), enforces auth/rate limits/tenant scope, persists jobs, enqueues work, and serves status/results/usage.
- **Worker** performs all network-heavy work: streaming CSV parse, DNS checks, exports, expiry. The SMTP probe stage exists only behind the Phase 0 gate (ADR-006) and, when enabled, runs in this separately deployable process so it can sit on an approved network.
- **Postgres** is the source of truth (ADR-003). **Redis/BullMQ** is transport and cache only (ADR-004); every job is reconcilable from Postgres after a restart.

## 2. Monorepo layout (PRD §5.3)

```text
apps/web        Next.js App Router dashboard (React + TypeScript, plain CSS)
apps/api        NestJS + Fastify REST API
apps/worker     NestJS + BullMQ consumers
packages/core       parsing, normalisation, DNS orchestration, classification (pure, fixture-tested)
packages/contracts  Zod schemas, status/reason-code enums, shared DTOs
packages/database   Prisma schema, migrations, client
packages/config     typed environment validation
packages/datasets   versioned disposable / role / free-provider datasets (source + licence recorded)
infra/docker    Dockerfiles (api, worker, web)
docs/           this documentation set + runbooks
scripts/        smtp-gate-check.mjs (production-candidate network gate)
docker-compose.yml  postgres:16, redis:7, api, worker, web with healthchecks
```

## 3. Verification pipeline (PRD §4.5)

1. **Normalise & parse** — trim, standards-based address parsing (no home-grown regex), lowercase domain, IDN→Punycode, SMTPUTF8 local parts reported as unsupported rather than rewritten, CRLF/control characters rejected.
2. **Local risk checks** — disposable dataset, role-prefix list, free-provider metadata (metadata only; free ≠ invalid).
3. **DNS/domain routing** — MX lookup; A/AAAA resolution of exchanges; NXDOMAIN vs SERVFAIL vs timeout distinguished; Null MX (`MX 0 .`) = domain accepts no mail; implicit-MX fallback to the domain's A/AAAA **only** when no MX exists; TTL-capped caching.
4. **Quick classification** — stages 1–3. Ceiling is `likely_valid` (+ `smtp_not_attempted_quick_mode`); Quick never claims a mailbox was tested.
5. **Deep SMTP probe (gated, not currently enabled)** — public-MX IPs only, IP blocklist re-validated at connect time, STARTTLS required before the target address is transmitted, EHLO → MAIL FROM (controlled identity) → RCPT TO → RSET → QUIT. **Never DATA. Never sends email.** Conservative enhanced-code interpretation.
6. **Catch-all (Deep only)** — at most one synthetic random recipient per domain per 24 h cache window; accepted synthetic ⇒ `catch_all_suspected`/`risky`; inconclusive ⇒ `likely_valid` + `catch_all_unchecked`, never a high-confidence `valid`.

Raw evidence is stored separately from the final classification; every result carries `checks_performed`, `reason_codes`, `observed_at`, `mode`, and a human-readable `explanation`. Confidence is qualitative (`high|medium|low`) — there is no numeric score anywhere in the system (ADR-005).

## 4. Bulk pipeline

Upload/paste → validation (type/size/row caps) → streaming parse (never whole-file in RAM) → email-column detection with manual override → row preservation (every original column, original order, stable row numbers) → normalisation + HMAC dedupe (duplicates point at the canonical row, never re-verified, never re-charged) → per-unique-address verification jobs → progress persisted on the batch row → filtered results API → CSV export with formula-injection escaping → source deleted after 24 h, results expire after 7 days (defaults).

## 5. Credits

Append-only `credit_ledger` with unique idempotency keys (ADR-008). Flow per batch: `reserve` (estimated billable maximum) → `charge` per completed billable unique check → `release` unused reservation on completion/cancel; `refund` for corrections. `unknown` outcomes and parse failures are never charged.

## 6. Data model

PRD §7 in full: `users`, `workspaces`, `api_keys` (hash only), `verification_batches`, `verification_records` (ciphertext + HMAC, evidence JSONB), `batch_rows`, `credit_ledger`, `domain_cache`, `webhook_endpoints` (P1), `audit_events`. UUID keys; `workspace_id` on every tenant-owned row; tenant scoping enforced in the service layer and covered by cross-tenant tests.

## 7. Observability (PRD §12)

Pino structured JSON logs (`request_id`, `workspace_id`, `batch_id`, stage, reason code — never plaintext addresses, keys, or passwords). Metrics: verification totals/durations by mode/status, DNS failure classes, SMTP outcomes (when enabled), queue wait/stalled jobs, credits charged/refunded, `unknown_rate` by provider family. Alerts: port-25 egress failure, unknown-rate spikes, queue backlog, DB saturation, deletion failures, ledger reconciliation mismatch. Runbooks in `docs/runbooks/`.

## 8. Deployment shape

Docker Compose (this repo) runs all five services on one host for local dev and closed beta. The worker is independently scalable/restartable, and is the only component that would ever need the port-25-approved network. See `docs/deployment.md`.
