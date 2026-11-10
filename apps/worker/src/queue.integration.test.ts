import { describe, it, expect } from "vitest";

/**
 * REAL Redis/BullMQ integration test — runs ONLY when REDIS_URL points at a
 * real Redis (CI provides one). Skipped gracefully locally. It enqueues a
 * bulk job on a real BullMQ queue, a real Worker processes it using the
 * production processors, and completion is asserted. This is NOT covered by
 * the in-memory processor tests.
 */
const REDIS_URL = process.env.REDIS_URL;
describe.skipIf(!REDIS_URL)("BullMQ + real Redis integration", () => {
  it("enqueue bulk verify job -> worker processes it -> batch completed", async () => {
    const { Queue, Worker } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;
    const { InMemoryWorkerRepository } = await import("./repositories");
    const { bulkParseProcessor, parseCsvText, verifyBatchProcessor } = await import("./processors");
    const connection = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    const queueName = `verify-it-${Date.now()}`;
    const repo = new InMemoryWorkerRepository();
    await repo.addLedger({ workspaceId: "ws-it", entryType: "grant", quantity: 100, idempotencyKey: "grant:it", batchId: null, recordId: null });
    const parsed = await parseCsvText("email\none@example.com\ntwo@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws-it", parsed, mode: "quick" });
    const dns = { async lookupDomain() { return { status: "ok" as const, mx: [{ exchange: "mx.example.com", priority: 10 }], hasAddressRecord: true, isNullMx: false }; } };
    const queue = new Queue(queueName, { connection });
    const worker = new Worker(queueName, async (job: any) => verifyBatchProcessor(repo, dns, { workspaceId: job.data.workspaceId, batchId: job.data.batchId }), { connection });
    try {
      const job = await queue.add("verify", { workspaceId: "ws-it", batchId: batch.id }, { attempts: 3, backoff: { type: "exponential", delay: 100 } });
      await job.waitUntilFinished((await import("bullmq")).QueueEvents ? new (await import("bullmq")).QueueEvents(queueName, { connection }) : undefined as any, 15000).catch(async () => {
        // Fallback poll if QueueEvents wiring differs by version.
        for (let i = 0; i < 50; i++) { const b = await repo.getBatch("ws-it", batch.id); if (b?.status === "completed") return; await new Promise((r) => setTimeout(r, 200)); }
      });
      const done = await repo.getBatch("ws-it", batch.id);
      expect(done?.status).toBe("completed");
      expect(done?.creditsCharged).toBe(2);
    } finally {
      await worker.close(); await queue.obliterate({ force: true }).catch(() => {}); await queue.close(); connection.disconnect();
    }
  }, 30000);
});
