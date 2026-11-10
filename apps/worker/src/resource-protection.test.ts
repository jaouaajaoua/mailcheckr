import { describe, it, expect } from "vitest";
import { withRetry } from "./retry";
import { DomainThrottle } from "./throttle";
import { InMemoryWorkerRepository } from "./repositories";
import { parseCsvText, bulkParseProcessor, markBatchDeadLetter } from "./processors";

describe("withRetry — bounded budget (PRD §11)", () => {
  it("succeeds after transient failures within budget", async () => {
    let n = 0;
    const v = await withRetry(async () => { n++; if (n < 3) throw new Error("boom"); return "ok"; }, { sleep: async () => {} });
    expect(v).toBe("ok"); expect(n).toBe(3);
  });
  it("gives up after exactly maxAttempts (default 3) and rethrows", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("always"); }, { sleep: async () => {} })).rejects.toThrow("always");
    expect(n).toBe(3);
  });
  it("applies exponential backoff delays", async () => {
    const delays: number[] = [];
    await expect(withRetry(async () => { throw new Error("x"); }, { baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } })).rejects.toThrow();
    expect(delays).toEqual([100, 200]);
  });
});

describe("DomainThrottle (PRD §10.3/§11)", () => {
  it("never exceeds max concurrent per domain (default 2)", async () => {
    const throttle = new DomainThrottle(2, 60_000);
    let concurrent = 0, peak = 0;
    const task = () => throttle.run("example.com", async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 10)); concurrent--; });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
  it("different domains are independent; cooldown map marks and clears", async () => {
    const throttle = new DomainThrottle(2, 60_000);
    await throttle.run("a.com", async () => {}); await throttle.run("b.com", async () => {});
    const now = Date.now();
    expect(throttle.isCoolingDown("a.com", now)).toBe(false);
    throttle.markFailure("a.com", now);
    expect(throttle.isCoolingDown("a.com", now + 1000)).toBe(true);
    expect(throttle.isCoolingDown("a.com", now + 61_000)).toBe(false);
    throttle.markSuccess("a.com");
    expect(throttle.isCoolingDown("a.com", now)).toBe(false);
  });
});

describe("CSV size caps (PRD §8.3/§10.4)", () => {
  it("rejects CSV over the byte cap with PAYLOAD_TOO_LARGE", async () => {
    const big = "email\n" + "a@example.com\n".repeat(50);
    await expect(parseCsvText(big, { maxBytes: 100 })).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
  });
  it("rejects CSV over the row cap", async () => {
    const many = "email\n" + "a@example.com\n".repeat(20);
    await expect(parseCsvText(many, { maxRows: 5 })).rejects.toThrow(/CSV_TOO_LARGE/);
  });
});

describe("dead-letter (PRD §11)", () => {
  it("markBatchDeadLetter moves a queued batch to failed; terminal batches untouched; idempotent", async () => {
    const repo = new InMemoryWorkerRepository();
    const parsed = await parseCsvText("email\none@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws1", parsed, mode: "quick" });
    const failed = await markBatchDeadLetter(repo, { workspaceId: "ws1", batchId: batch.id, error: "boom" });
    expect(failed?.status).toBe("failed");
    const again = await markBatchDeadLetter(repo, { workspaceId: "ws1", batchId: batch.id, error: "boom" });
    expect(again?.status).toBe("failed");
  });
});
