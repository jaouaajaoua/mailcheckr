import type { WorkerRepository } from "./repositories";
import type { DnsResolver } from "./verify";
import { bulkParseProcessor, verifyBatchProcessor, exportBatchProcessor, expireBatchesProcessor, parseCsvStream, markBatchDeadLetter } from "./processors";

/** Retry budget for every queue (PRD §11): 3 attempts, exponential backoff. */
export const DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 } as const;

/**
 * BullMQ wiring (queues: bulk-parse, verify, export, scheduler).
 * BullMQ/ioredis are imported lazily so importing this module in tests
 * (without Redis) has no side effects. Processors above are the testable
 * units; these workers are thin, idempotent adapters over them.
 */
export const QUEUE_NAMES = { bulkParse: "bulk-parse", verify: "verify", export: "export", scheduler: "scheduler" } as const;

export function createBullWorkers(repo: WorkerRepository, dns: DnsResolver, redisUrl: string, opts: { deepEnabled: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker, Queue } = require("bullmq");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require("ioredis");
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const workers = [
    new Worker(QUEUE_NAMES.bulkParse, async (job: any) => {
      const parsed = await parseCsvStream(job.data.sourceStream, { emailColumn: job.data.emailColumn });
      return bulkParseProcessor(repo, { workspaceId: job.data.workspaceId, parsed, mode: job.data.mode ?? "quick" });
    }, { connection, concurrency: 2 }),
    new Worker(QUEUE_NAMES.verify, async (job: any) => verifyBatchProcessor(repo, dns, { workspaceId: job.data.workspaceId, batchId: job.data.batchId, deepEnabled: opts.deepEnabled }), { connection, concurrency: 5 }),
    new Worker(QUEUE_NAMES.export, async (job: any) => exportBatchProcessor(repo, { workspaceId: job.data.workspaceId, batchId: job.data.batchId }), { connection, concurrency: 2 }),
    new Worker(QUEUE_NAMES.scheduler, async () => expireBatchesProcessor(repo), { connection, concurrency: 1 }),
  ];
  const queues = Object.values(QUEUE_NAMES).map((name) => new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }));
  for (const w of workers) {
    w.on("failed", async (job: any, err: Error) => {
      if (job?.data?.batchId && job?.data?.workspaceId && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 3)) {
        await markBatchDeadLetter(repo, { workspaceId: job.data.workspaceId, batchId: job.data.batchId, error: err.message });
      }
    });
  }
  return { workers, queues, connection };
}
