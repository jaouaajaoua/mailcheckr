# Runbook — Database restore (PostgreSQL)

## Before you need this
- Nightly logical backups (`pg_dump`) of the `mailcheckr` database to object storage, retained 14 days, plus the compose volume snapshot on the host. **Test this runbook quarterly** — an untested restore is a hope, not a backup.
- Know the deletion-propagation caveat: restores resurrect data deleted after the backup was taken. After any restore, re-apply pending deletion requests (see `data-deletion.md`) before reopening traffic.

## Symptoms
Data corruption, bad migration, accidental deletion, or host loss requiring a rebuild.

## Procedure
1. **Freeze writes:** `docker compose stop api worker web` (leave `postgres`/`redis` decisions explicit — for host loss, start from the compose file on the new host).
2. Identify the target backup: latest dump **before** the incident timestamp. Record its filename/time in the incident notes.
3. On a clean database:
   ```bash
   docker compose up -d postgres
   docker compose exec -T postgres dropdb -U mailcheckr --if-exists mailcheckr
   docker compose exec -T postgres createdb -U mailcheckr mailcheckr
   cat backup-<timestamp>.sql | docker compose exec -T postgres psql -U mailcheckr -d mailcheckr
   ```
4. Apply migrations forward to the deployed code version:
   ```bash
   docker compose run --rm api pnpm --filter @mailcheckr/database exec prisma migrate deploy
   ```
5. **Reconcile:** ledger-vs-batch reconciliation query (charged totals per batch equal the sum of terminal billable records); any batch left non-terminal goes through `stuck-batch.md`. Re-apply deletion requests received after the backup point.
6. Smoke test in order: health endpoint → login → `GET /v1/usage` → one Quick verification → one small batch. Only then `docker compose up -d web api worker` for full traffic.

## Verification checklist
- [ ] Row counts for `users`, `workspaces`, `credit_ledger` match backup expectations.
- [ ] Ledger reconciliation clean (no batch charged ≠ billable terminal records).
- [ ] Post-backup deletions re-applied and verified absent.
- [ ] Incident timeline + backup used recorded in the ops log.

## Prevention
- Migrations are reviewed, reversible where feasible, and never edited after deploy; destructive migrations ship in two steps (expand → contract).
