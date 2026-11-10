import { describe, it, expect } from "vitest";
import { InMemoryRepository } from "../src/repositories/in-memory.repository";
import { RetentionService } from "../src/retention/retention.service";
import { BatchesService } from "../src/batches/batches.service";
import { VerificationService } from "../src/verification/verification.service";
import { fakeDns, OK_MX, testConfig } from "./helpers";

async function seedBatch(repo: InMemoryRepository) {
  const ws = await repo.createWorkspace({ ownerUserId: "u1", name: "WS" });
  const { CreditLedgerService } = await import("../src/credits/credit-ledger.service");
  await new CreditLedgerService(repo).grant(ws.id, 100, "grant:test");
  const batches = new BatchesService(repo, testConfig, new VerificationService(fakeDns({ "example.com": OK_MX })));
  const created = await batches.createBatch({ workspaceId: ws.id, userId: "u1", emails: ["one@example.com", "two@example.com"], mode: "quick" });
  await batches.processInline(ws.id, created.id);
  return { ws, batches, batchId: created.id };
}

describe("RetentionService — verified deletion (PRD §10.2)", () => {
  it("purgeBatch removes records/rows/batch, severs ledger links, writes audit", async () => {
    const repo = new InMemoryRepository();
    const { ws, batchId } = await seedBatch(repo);
    expect(await repo.countRecords(ws.id)).toBe(2);
    expect((await repo.listBatchRows(batchId)).length).toBe(2);
    const retention = new RetentionService(repo);
    const res = await retention.purgeBatch(ws.id, batchId, "u1");
    expect(res).toEqual({ deleted: true, recordsRemoved: 2 });
    // Data is verifiably gone:
    expect(await repo.findBatchById(ws.id, batchId)).toBeNull();
    expect(await repo.countRecords(ws.id)).toBe(0);
    expect((await repo.listBatchRows(batchId)).length).toBe(0);
    const ledger = await repo.listLedger(ws.id, { limit: 100, offset: 0 });
    expect(ledger.length).toBeGreaterThan(0); // accounting rows kept
    expect(ledger.every((e) => e.batchId === null)).toBe(true); // personal-data links severed
    expect(repo.audits.some((a) => a.action === "batch.purge" && a.resourceId === batchId)).toBe(true);
  });
  it("purgeExpired expires batches past retention and deletes their records; idempotent", async () => {
    const repo = new InMemoryRepository();
    const { ws, batches, batchId } = await seedBatch(repo);
    await repo.updateBatch(ws.id, batchId, { expiresAt: new Date(Date.now() - 1000) });
    const retention = new RetentionService(repo);
    expect((await retention.purgeExpired(new Date())).expired).toBe(1);
    expect((await repo.findBatchById(ws.id, batchId))?.status).toBe("expired");
    expect(await repo.countRecords(ws.id)).toBe(0);
    expect((await retention.purgeExpired(new Date())).expired).toBe(0);
    void batches;
  });
  it("purgeBatch on another tenant's batch is a no-op (tenant isolation)", async () => {
    const repo = new InMemoryRepository();
    const { ws, batchId } = await seedBatch(repo);
    const retention = new RetentionService(repo);
    expect((await retention.purgeBatch("other-workspace", batchId)).deleted).toBe(false);
    expect(await repo.countRecords(ws.id)).toBe(2);
  });
});
