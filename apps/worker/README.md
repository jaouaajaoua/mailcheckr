# @mailcheckr/worker

BullMQ worker (PRD §5.4): queues `bulk-parse`, `verify`, `export`, `scheduler`.

Processors (`src/processors.ts`) are pure, testable functions over a
repository interface (in-memory implementation included for tests; the API's
Prisma repository implements the same semantics in production):
- `parseCsvStream` — streaming csv-parse, email-column detection, 10k row cap
- `bulkParseProcessor` — dedupe, reserve credits for unique rows only
- `verifyBatchProcessor` — idempotent verification + credit settlement
  (unknown and duplicates are never charged; re-runs after a crash are safe)
- `exportBatchProcessor` — preserves all original columns and row order,
  CSV formula-injection escaping
- `expireBatchesProcessor` — retention expiry + record deletion

`src/queues.ts` / `src/main.ts` wire processors to BullMQ/Redis. The worker
requires REDIS_URL; without it, main exits with an explicit message rather
than pretending to run. Deep SMTP is never enabled unless both
SMTP_DEEP_ENABLED and SMTP_EGRESS_APPROVED are true.

Resource protection: `withRetry` caps verification attempts at 3 with
exponential backoff (queues use BullMQ `attempts: 3` + exponential backoff;
exhausted jobs move the batch to a terminal `failed` dead-letter state via
`markBatchDeadLetter`). `DomainThrottle` allows at most
`MAX_CONCURRENT_PER_DOMAIN` (default 2) in-flight verifications per domain
with a per-domain cooldown map (`DOMAIN_COOLDOWN_MS`, default 60s). CSV caps:
10,000 rows / 5 MB (`PAYLOAD_TOO_LARGE`).

`src/queue.integration.test.ts` runs only when `REDIS_URL` points at a real
Redis (`describe.skipIf`): it enqueues a real BullMQ job and asserts the
worker processes it. Locally skipped — in-memory processor tests do NOT
prove real-queue behaviour.
