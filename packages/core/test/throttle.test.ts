import { describe, it, expect } from "vitest";
import { DomainThrottle, DomainThrottleTimeoutError } from "../src/smtp/throttle";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("DomainThrottle — per-domain concurrency cap", () => {
  it("admits up to maxConcurrentPerDomain immediately, blocks the next", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 2, queueTimeoutMs: 1_000 });
    const r1 = await t.acquire("example.com");
    const r2 = await t.acquire("example.com");
    expect(t.activeCount("example.com")).toBe(2);
    expect(t.tryAcquire("example.com")).toBeNull();
    r1();
    expect(t.activeCount("example.com")).toBe(1);
    const r3 = t.tryAcquire("example.com");
    expect(r3).not.toBeNull();
    r2();
    r3?.();
    expect(t.activeCount("example.com")).toBe(0);
  });

  it("queues excess acquirers FIFO and admits them as slots free", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1, queueTimeoutMs: 1_000 });
    const first = await t.acquire("example.com");
    const order: string[] = [];
    const p2 = t.acquire("example.com").then((rel) => { order.push("second"); return rel; });
    const p3 = t.acquire("example.com").then((rel) => { order.push("third"); return rel; });
    await tick();
    expect(t.queuedCount("example.com")).toBe(2);
    first();
    const second = await p2;
    expect(order).toEqual(["second"]);
    expect(t.activeCount("example.com")).toBe(1);
    second();
    const third = await p3;
    expect(order).toEqual(["second", "third"]);
    third();
    expect(t.activeCount("example.com")).toBe(0);
  });

  it("queue wait beyond queueTimeoutMs rejects with DomainThrottleTimeoutError", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1, queueTimeoutMs: 30 });
    const held = await t.acquire("example.com");
    await expect(t.acquire("example.com")).rejects.toBeInstanceOf(DomainThrottleTimeoutError);
    expect(t.queuedCount("example.com")).toBe(0); // timed-out waiter is removed
    held();
    // Slot is usable again after the timeout path ran.
    const again = await t.acquire("example.com");
    again();
  });

  it("a timed-out waiter does not consume the slot when it later frees", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1, queueTimeoutMs: 20 });
    const held = await t.acquire("example.com");
    await expect(t.acquire("example.com")).rejects.toBeInstanceOf(DomainThrottleTimeoutError);
    held();
    expect(t.activeCount("example.com")).toBe(0);
    const rel = t.tryAcquire("example.com");
    expect(rel).not.toBeNull();
    rel?.();
  });

  it("limits are per-domain: a saturated domain does not block others", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1, queueTimeoutMs: 50 });
    const a = await t.acquire("a.example.com");
    const b = await t.acquire("b.example.com"); // resolves immediately
    expect(t.activeCount("a.example.com")).toBe(1);
    expect(t.activeCount("b.example.com")).toBe(1);
    a();
    b();
  });

  it("domain keys are normalized (case/whitespace-insensitive)", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1 });
    const rel = await t.acquire("  Example.COM ");
    expect(t.activeCount("example.com")).toBe(1);
    expect(t.tryAcquire("EXAMPLE.com")).toBeNull();
    rel();
  });

  it("release is idempotent — double release does not over-admit", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1, queueTimeoutMs: 50 });
    const rel = await t.acquire("example.com");
    rel();
    rel();
    expect(t.activeCount("example.com")).toBe(0);
    const one = t.tryAcquire("example.com");
    expect(one).not.toBeNull();
    expect(t.tryAcquire("example.com")).toBeNull(); // still capped at 1
    one?.();
  });

  it("run() holds the slot for the duration and releases on success and on throw", async () => {
    const t = new DomainThrottle({ maxConcurrentPerDomain: 1 });
    const seen: number[] = [];
    await t.run("example.com", async () => { seen.push(t.activeCount("example.com")); });
    expect(seen).toEqual([1]);
    expect(t.activeCount("example.com")).toBe(0);
    await expect(t.run("example.com", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(t.activeCount("example.com")).toBe(0);
  });

  it("defaults: max 2 concurrent per domain", async () => {
    const t = new DomainThrottle();
    const r1 = await t.acquire("example.com");
    const r2 = await t.acquire("example.com");
    expect(t.tryAcquire("example.com")).toBeNull();
    r1();
    r2();
  });
});
