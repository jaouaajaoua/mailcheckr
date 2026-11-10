import { describe, it, expect } from "vitest";
import { InMemoryRepository } from "../src/repositories/in-memory.repository";
import { CreditLedgerService } from "../src/credits/credit-ledger.service";

describe("CreditLedgerService (PRD §9)", () => {
  it("grant + balance, idempotent grant (same key twice = one entry)", async () => {
    const repo = new InMemoryRepository();
    const credits = new CreditLedgerService(repo);
    await credits.grant("ws1", 100, "grant:1");
    await credits.grant("ws1", 100, "grant:1"); // retry
    expect(await credits.balance("ws1")).toBe(100);
    expect(repo.ledger.size).toBe(1);
  });
  it("charge idempotency: same key twice = one charge", async () => {
    const repo = new InMemoryRepository();
    const credits = new CreditLedgerService(repo);
    await credits.grant("ws1", 100, "g");
    await credits.chargeForVerification({ workspaceId: "ws1", recordId: "r1", status: "likely_valid", idempotencyKey: "charge:r1" });
    await credits.chargeForVerification({ workspaceId: "ws1", recordId: "r1", status: "likely_valid", idempotencyKey: "charge:r1" });
    expect(await credits.balance("ws1")).toBe(99);
  });
  it("unknown outcomes are NOT charged", async () => {
    const repo = new InMemoryRepository();
    const credits = new CreditLedgerService(repo);
    await credits.grant("ws1", 100, "g");
    const res = await credits.chargeForVerification({ workspaceId: "ws1", recordId: "r2", status: "unknown", idempotencyKey: "charge:r2" });
    expect(res).toBeNull();
    expect(await credits.balance("ws1")).toBe(100);
  });
  it("reserve refuses when balance is insufficient; release restores", async () => {
    const repo = new InMemoryRepository();
    const credits = new CreditLedgerService(repo);
    await credits.grant("ws1", 5, "g");
    await expect(credits.reserve("ws1", 10, "b1", "reserve:b1")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    await credits.reserve("ws1", 5, "b1", "reserve:b1");
    expect(await credits.balance("ws1")).toBe(0);
    await credits.release("ws1", 5, "b1", "release:b1");
    await credits.release("ws1", 5, "b1", "release:b1"); // idempotent
    expect(await credits.balance("ws1")).toBe(5);
  });
  it("refund is idempotent", async () => {
    const repo = new InMemoryRepository();
    const credits = new CreditLedgerService(repo);
    await credits.refund("ws1", 3, "refund:1");
    await credits.refund("ws1", 3, "refund:1");
    expect(await credits.balance("ws1")).toBe(3);
  });
});
