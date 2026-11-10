import { InMemoryWorkerRepository } from "./repositories";
import { createBullWorkers, QUEUE_NAMES } from "./queues";
import { NodeDnsResolver } from "./node-dns";

/**
 * Worker entrypoint. Requires REDIS_URL + DATABASE_URL in production.
 * In this sandbox neither exists, so the process reports the missing wiring
 * honestly and exits — processors are covered by unit tests instead.
 * Deep SMTP stays disabled unless BOTH gate flags are true (PRD §6).
 */
async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error("[worker] REDIS_URL is not set — BullMQ workers cannot start. Set REDIS_URL (and DATABASE_URL for the Prisma repository) to run the worker. Processors are unit-tested with the in-memory repository.");
    process.exit(1);
  }
  const deepEnabled = process.env.SMTP_DEEP_ENABLED === "true" && process.env.SMTP_EGRESS_APPROVED === "true";
  // NOTE: production must inject the Prisma-backed repository here; the
  // in-memory repository is for tests/dev only and does not persist.
  const repo = new InMemoryWorkerRepository();
  const { queues } = createBullWorkers(repo, new NodeDnsResolver(), redisUrl, { deepEnabled });
  const scheduler = queues.find((q: any) => q.name === QUEUE_NAMES.scheduler);
  await scheduler?.add("expire-batches", {}, { repeat: { every: 60 * 60 * 1000 }, jobId: "expire-batches-hourly" });
  console.log(`[worker] BullMQ workers started (deep SMTP enabled: ${deepEnabled})`);
}
void main();
