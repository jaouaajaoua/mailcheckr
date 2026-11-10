# Deployment

Two supported shapes: **Docker Compose** (local development and single-host closed beta) and **manual Node processes** (development without Docker). Production hardening items are listed honestly at the end — Compose alone is not a production security posture.

## 1. Prerequisites

- Docker + Docker Compose v2 (for the Compose path), or Node.js 22 + pnpm 9.15 + PostgreSQL 16 + Redis 7 (manual path).
- A filled-in `.env` (start from `.env.example`; generate real secrets — see §4).
- For Deep SMTP only: a passed Phase 0 gate on **this** host (see §5). Otherwise leave Deep off.

## 2. Docker Compose (recommended)

```bash
cp .env.example .env        # fill in every change-me value
docker compose up -d postgres redis
docker compose run --rm api pnpm --filter @mailcheckr/database exec prisma migrate deploy
docker compose up -d --build
```

- Web: http://localhost:3000 · API: http://localhost:4000 (health: `GET /health`)
- Services start in dependency order with healthchecks (`pg_isready`, `redis-cli ping`, API `/health`, web `/`).
- The worker publishes no ports. Postgres/Redis ports are published for local inspection — **remove those `ports:` entries on any shared/production host** and keep them on the internal network only.
- Stop: `docker compose down` (add `-v` only if you intend to destroy the data volumes).

## 3. Without Docker

```bash
pnpm install --frozen-lockfile
# Postgres 16 and Redis 7 running locally; .env DATABASE_URL/REDIS_URL point at them
pnpm --filter @mailcheckr/database exec prisma migrate deploy
pnpm --filter @mailcheckr/api build && pnpm --filter @mailcheckr/worker build && pnpm --filter @mailcheckr/web build
pnpm --filter @mailcheckr/api start   # :4000
pnpm --filter @mailcheckr/worker start
pnpm --filter @mailcheckr/web start   # :3000
```

(In the Muse build sandbox this path is also blocked for full-stack work: no Postgres/Redis binaries exist there — see `phase-0-audit.md`.)

## 4. Secrets

Generate per-environment values; never reuse the examples:

```bash
openssl rand -hex 32   # JWT_SECRET and ENCRYPTION_KEY (64 hex chars)
openssl rand -hex 24   # HMAC_KEY, API_KEY_PEPPER, POSTGRES_PASSWORD
```

`.env` is git-ignored and docker-ignored. In a real production deployment prefer the platform's secret manager over a file, and scope `ENCRYPTION_KEY`/`HMAC_KEY` access to api+worker only.

## 5. Enabling Deep SMTP (the gate — do not skip)

1. Read `docs/phase-0-audit.md` §4 and choose a candidate whose port-25 posture allows approval (shortlist: Hetzner, Vultr, AWS EC2; DigitalOcean/GCP are excluded for the worker role).
2. Provision the **worker** host with a static egress IP; set PTR/rDNS to the controlled probe domain; publish matching forward DNS + SPF.
3. Obtain written provider approval where required.
4. Run on the worker host: `node scripts/smtp-gate-check.mjs` — it must exit 0. File its JSON output with the approval as the evidence pack.
5. Set `SMTP_DEEP_ENABLED=true` and `SMTP_EGRESS_APPROVED=true` for the worker only, redeploy the worker, record a new ADR in `docs/DECISIONS.md`, and monitor `unknown_rate` + SMTP failure metrics for 24 h.

If any step fails, Deep stays off and Quick mode remains the product. There is no supported "partial" Deep mode.

## 6. Updates and migrations

```bash
git pull
docker compose build
docker compose run --rm api pnpm --filter @mailcheckr/database exec prisma migrate deploy
docker compose up -d
```

Migrations run as an explicit step before the new API/worker start, never as an app-boot side effect. Back up first (`runbooks/db-restore.md`).

## 7. Production checklist (Phase 8 — not all satisfied by Compose)

- [ ] TLS terminated in front of web+API (reverse proxy or platform), HSTS on.
- [ ] Postgres/Redis not publicly reachable; volumes backed up nightly (14-day retention) with a **tested** restore.
- [ ] `CORS_ORIGINS` set to the real dashboard origin only; `NODE_ENV=production`; debug logging off.
- [ ] Metrics/alerts wired per `architecture.md` §7 (egress failure, unknown-rate spike, queue backlog, DB saturation, deletion failures, ledger mismatch).
- [ ] Reverse proxy request-size limits aligned with the CSV caps (10,000 rows).
- [ ] Trademark/domain clearance for the name before public branding (R-13).
- [ ] Privacy notice, terms, and DPA reviewed by counsel (R-14).
