# Runbook — Redis outage

Redis carries BullMQ queues, DNS/result cache, and rate-limit state. **Postgres is the source of truth** (ADR-003/004): an outage pauses work; it must never lose batches or double-charge credits.

## Symptoms
- API returns errors on batch creation; workers log BullMQ connection errors; `queue_wait_seconds` frozen; healthcheck for the `redis` service failing.

## Immediate actions
1. Check the service: `docker compose ps redis`, `docker compose logs --tail=100 redis`, host disk/memory (AOF persistence is on; a full disk is the usual cause).
2. Restart in place: `docker compose restart redis`. Verify `docker compose exec redis redis-cli ping` → `PONG`.
3. Restart workers so BullMQ connections re-establish cleanly: `docker compose restart worker`.

## Recovery verification
- Batches stuck in `queued`/`processing` resume: handlers are idempotent and batch state is reconciled from Postgres, so re-delivery is safe.
- Spot-check one in-flight batch end-to-end and confirm its ledger entries show each idempotency key exactly once (`reserve`/`charge`/`release` sequence intact). If duplicates appear, stop and escalate — that indicates a ledger bug, not a Redis problem.
- Rate limiting fails *closed* for verification-creating endpoints while Redis is down (API returns 503/`RATE_LIMITED`-style errors rather than unlimited access); confirm normal behaviour resumes after recovery.

## If Redis data is lost entirely
- Queues are rebuilt from Postgres: any batch in a non-terminal state is re-enqueued by the scheduler's reconciliation job. DNS cache simply repopulates (expect a temporary latency/unknown bump from cold cache).
- Do not "fix" stuck batches by editing rows by hand; use `stuck-batch.md`.

## Prevention
- Alert on Redis healthcheck failure and memory > 75%; keep AOF enabled; size the volume with headroom; include Redis in the host backup snapshot (for queue convenience — correctness never depends on it).
