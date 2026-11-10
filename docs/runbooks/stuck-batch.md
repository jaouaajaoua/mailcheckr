# Runbook — Stuck batch reconciliation

A batch is "stuck" when it stays in `created`/`queued`/`processing` well beyond its expected duration (alert: `queue_stalled_jobs_total` / age check) with no progress in `completed_count`.

## Diagnosis (in order)
1. **Worker alive?** `docker compose ps worker`, recent worker logs for the `batch_id`. A crashed/restart-looping worker is the most common cause → fix the worker first (`redis-outage.md` if Redis is implicated).
2. **Queue state:** is the batch's job waiting, active, or failed in BullMQ? Failed jobs carry the handler error — read it before retrying anything.
3. **Database state:** compare `row_count`/`unique_count` with the count of `verification_records` for the batch and the ledger sequence. Because handlers are idempotent, partial progress is normal and safe to resume.

## Resolution
- **Worker was down:** restart it. The scheduler's reconciliation re-enqueues non-terminal batches from Postgres; verify progress resumes within a few minutes.
- **Job failed with a transient error** (DNS timeout storm, downstream restart): trigger the batch retry path (re-enqueue from the API/admin action) rather than editing rows.
- **Job failed with a deterministic error** (corrupt source file, parser edge case): preserve the source + error, mark the batch `failed` via the service (which releases the unused credit reservation — verify a ledger `release` entry), and contact the workspace owner with the explanation. Never hand-edit `status` in SQL: the credit release and audit event are part of the transition.
- **Credits look wrong:** do not "fix" the balance field. Balances derive from the ledger (ADR-008). If the ledger itself is wrong, add a compensating `adjustment` entry with a description referencing the incident — history is never rewritten.

## Verification
- Batch reaches a terminal state; `completed_count` + duplicates + parse errors account for every row.
- Ledger: `credits_charged` equals the count of billable terminal unique records (never duplicates, never `unknown`).
- The workspace owner can load the results page and export successfully.

## Prevention
- Stalled-job alerting with a sane threshold; worker liveness probe; bounded per-record timeouts so one pathological domain cannot pin a batch.
