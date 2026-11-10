# Architecture Decision Records

Each decision records context, the choice made, and its consequences. Statuses: *Accepted*, *Blocked*, *Deferred*. New decisions are appended; superseded decisions keep their history.

---

## ADR-001 — pnpm monorepo with apps + packages layout

- **Status:** Accepted (Phase 1)
- **Context:** PRD §5.3 prescribes a TypeScript monorepo separating web, API, worker, and shared packages so the SMTP worker can be deployed and network-isolated independently.
- **Decision:** pnpm workspaces (`pnpm-workspace.yaml`, packages: `apps/*`, `packages/*`). Layout: `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker` (BullMQ), `packages/{core,contracts,database,config,datasets}`. Lockfile committed; versions pinned per package.
- **Consequences:** Shared contracts/core are consumed as workspace packages; builds must filter by package (`pnpm --filter`). The web app can also be typechecked standalone (`apps/web` has its own tsconfig).

## ADR-002 — NestJS on the Fastify adapter for API and worker

- **Status:** Accepted (Phase 1)
- **Context:** PRD §5.2 selects NestJS + Fastify for the API (validation, rate limits, API-key auth) and a NestJS worker process for BullMQ consumers.
- **Decision:** Both `apps/api` and `apps/worker` are NestJS applications; the API uses `@nestjs/platform-fastify`. Business logic lives in services/packages, never in controllers, so the worker reuses the same verification core as the API.
- **Consequences:** One framework idiom across server tiers; Fastify gives the throughput headroom for bulk-status polling without a separate gateway.

## ADR-003 — Prisma + PostgreSQL as the source of truth

- **Status:** Accepted (Phase 2)
- **Context:** PRD §7 defines a relational model (users, workspaces, batches, records, ledger, domain cache, audit) with UUID keys and `workspace_id` on every tenant-owned record.
- **Decision:** Prisma schema + migrations in `packages/database`; PostgreSQL 16 is the only system of record. Redis is never authoritative (ADR-004).
- **Consequences:** Migrations are an explicit deploy step (`prisma migrate deploy`), not an app-boot side effect. Tenant scoping is enforced at the service layer and tested cross-tenant.

## ADR-004 — BullMQ on Redis for job transport

- **Status:** Accepted (Phase 4)
- **Context:** Bulk verification must be resumable, idempotent, and survive worker restarts (PRD §11). Queue payloads must not carry raw email addresses (PRD §10.3) — jobs reference record IDs.
- **Decision:** BullMQ queues on Redis 7 for batch parsing, per-address verification, and exports. Every handler is idempotent; batch state transitions are persisted in Postgres before/after queue operations so a restart reconciles from the database, not from queue memory.
- **Consequences:** Redis outage pauses processing but loses no state (see `runbooks/redis-outage.md`). At-least-once delivery is assumed everywhere.

## ADR-005 — Conservative classification; no numeric score

- **Status:** Accepted (Phase 3)
- **Context:** PRD §4 forbids a vague boolean and any invented 0–100 "AI score". SMTP evidence is inherently partial (catch-all, greylisting, deferred validation, policy 550s).
- **Decision:** Canonical statuses `valid | likely_valid | invalid | risky | unknown` (+ row-level `duplicate`), stable reason codes (§4.3 plus `catch_all_unchecked` from §4.6), and qualitative confidence `high | medium | low`. A generic SMTP 550 is **never** mapped to `invalid` — only a narrowly recognised definitive mailbox-not-found response (e.g. enhanced `5.1.1`) is. Quick mode's ceiling is `likely_valid` with reason `smtp_not_attempted_quick_mode`.
- **Consequences:** Some addresses competitors label "valid" will be `likely_valid`/`unknown` here. That is the product's stated differentiation (explainability over bravado) and is surfaced honestly in the UI and docs.

## ADR-006 — Deep SMTP is release-gated and currently BLOCKED

- **Status:** **Blocked** (Phase 0, evidence in `docs/phase-0-audit.md`)
- **Context:** PRD §6 makes outbound TCP/25 a hard gate. The build sandbox has proxy-only HTTP egress, a system resolver that refuses MX queries (`EREFUSED`), no direct DNS, no Docker, no production host, no provider, and no written approval.
- **Decision:** Deep mode ships disabled behind **two** independent flags — `SMTP_DEEP_ENABLED` and `SMTP_EGRESS_APPROVED`, both default `false`. The UI disables Deep with an explanation; the API rejects Deep requests instead of simulating results. Re-enabling requires the full evidence pack of phase-0-audit §4.1 (gate script output on the real worker host + PTR/rDNS + written provider approval), recorded as a new ADR.
- **Consequences:** Phase 5 (SMTP engine) is not implemented until the gate passes. No third-party verifier is substituted and no proxy tunnelling is used — both are explicitly forbidden by the PRD.

## ADR-007 — Application-layer encryption + HMAC for stored addresses

- **Status:** Accepted (Phase 2)
- **Context:** PRD §7.5/§10.1: uploaded addresses are personal data. Deduplication needs a lookup digest, but an unsalted plain hash of an email is trivially reversible by dictionary attack.
- **Decision:** Email values are stored as AES-256-GCM ciphertext (`ENCRYPTION_KEY`, 32-byte key) alongside an HMAC digest (`HMAC_KEY`, a separate key) used for duplicate lookup. Redis job payloads carry record IDs only. Operational logs never contain plaintext addresses.
- **Consequences:** Key loss = stored addresses unrecoverable (by design; retention is short). Key rotation requires a re-encryption migration and is a documented operational procedure, not an env-var swap.

## ADR-008 — Ledger-only credit accounting

- **Status:** Accepted (Phase 4)
- **Context:** PRD §9: charging must be auditable and idempotent — duplicates and `unknown` outcomes are never charged; cancelled jobs release reservations.
- **Decision:** All credit movement goes through an append-only `credit_ledger` with a unique `idempotency_key` per mutation (`grant | reserve | charge | release | refund | purchase | adjustment`). Balances are derived from the ledger; any cached balance field is a projection, never the source of truth, and reconciliation compares the two.
- **Consequences:** Double-charging after a worker retry is prevented by the unique idempotency key at the database level, not by application care alone. Ledger rows are retained beyond result expiry because they are the accounting record (they reference batches by ID, not email content).

## ADR-009 — Plain CSS for the web app (no Tailwind)

- **Status:** Accepted (Phase 7)
- **Context:** The dashboard needs clean, professional, accessible styling with minimal build risk in a sandbox without a design system.
- **Decision:** A single hand-written `app/globals.css` with CSS variables. No utility-framework dependency until a design system is actually adopted.
- **Consequences:** Fewer build-time failure modes; styling changes are plain CSS edits. Revisit if the marketing site grows.

## ADR-010 — Browser talks to the API directly; JWT in localStorage

- **Status:** Accepted (Phase 6/7, with a recorded trade-off)
- **Context:** The dashboard and API are separate origins in development and in the Compose deployment. The task contract for this build specifies a JWT in `localStorage` via a small API client (`apps/web/lib/api.ts`, base `NEXT_PUBLIC_API_URL`, default `http://localhost:4000`).
- **Decision:** Dashboard auth uses a bearer JWT stored in `localStorage`; the API enforces a strict CORS allowlist. API keys (`mc_live_…`, hashed server-side, shown once) are the server-to-server credential and are never used by the browser.
- **Consequences / trade-off:** `localStorage` tokens are readable by any XSS on the dashboard origin, unlike HttpOnly cookies (PRD §10.4 prefers secure HttpOnly SameSite cookies for dashboard sessions). Mitigations in place: strict CSP/security headers at the API and web tiers, no third-party scripts on authenticated pages, short token lifetime (`JWT_EXPIRES_IN=1h`). **Follow-up before public launch:** migrate dashboard sessions to HttpOnly SameSite cookies + CSRF controls and record the superseding ADR.
