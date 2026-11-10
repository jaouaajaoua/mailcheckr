import { describe, it, expect } from "vitest";
import { InMemoryWorkerRepository } from "./repositories";
import { parseCsvText, bulkParseProcessor, verifyBatchProcessor, exportBatchProcessor, expireBatchesProcessor } from "./processors";
import type { DnsResolver } from "./verify";

const dns: DnsResolver = {
  async lookupDomain(domain: string) {
    if (domain === "example.com" || domain === "gmail.com") return { status: "ok", mx: [{ exchange: "mx.example.com", priority: 10 }], hasAddressRecord: true, isNullMx: false };
    if (domain === "flaky.example.com") return { status: "servfail", mx: [], hasAddressRecord: false, isNullMx: false };
    return { status: "nxdomain", mx: [], hasAddressRecord: false, isNullMx: false };
  },
};

const CSV = `name,email,company
One,one@example.com,Acme
Two,two@example.com,Acme
Dup,one@example.com,Acme
Bad,bad-syntax,Acme
Flaky,flaky@flaky.example.com,Acme
`;

describe("worker processors (PRD §Phase 4)", () => {
  it("streaming CSV parse detects email column and preserves original columns", async () => {
    const parsed = await parseCsvText(CSV);
    expect(parsed.emailColumn).toBe("email");
    expect(parsed.headers).toEqual(["name", "email", "company"]);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[0].original.company).toBe("Acme");
  });
  it("bulk parse dedupes; verify charges unique billable only — duplicates & unknown free; idempotent re-run", async () => {
    const repo = new InMemoryWorkerRepository();
    await repo.addLedger({ workspaceId: "ws1", entryType: "grant", quantity: 100, idempotencyKey: "grant:ws1", batchId: null, recordId: null });
    const parsed = await parseCsvText(CSV);
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws1", parsed, mode: "quick" });
    expect(batch.uniqueCount).toBe(4);
    expect(batch.duplicateCount).toBe(1);
    expect(await repo.sumLedger("ws1")).toBe(96); // reserved 4
    const done = await verifyBatchProcessor(repo, dns, { workspaceId: "ws1", batchId: batch.id });
    expect(done.status).toBe("completed");
    expect(done.completedCount).toBe(4);
    // billable: one, two (likely_valid) + bad-syntax (invalid) = 3; flaky = unknown (free)
    expect(done.creditsCharged).toBe(3);
    expect(done.unknownCount).toBe(1);
    expect(await repo.sumLedger("ws1")).toBe(97); // 100 - 3 charges, reserve fully released
    // Idempotent re-run after "restart": no new records, no new charges.
    const again = await verifyBatchProcessor(repo, dns, { workspaceId: "ws1", batchId: batch.id });
    expect(again.creditsCharged).toBe(3);
    expect(await repo.sumLedger("ws1")).toBe(97);
    expect((await repo.listRecords("ws1", batch.id)).length).toBe(4);
  });
  it("export preserves original columns + row order, marks duplicates, escapes formula injection", async () => {
    const repo = new InMemoryWorkerRepository();
    const parsed = await parseCsvText("name,email\n=2+5,evil@example.com\nOne,one@example.com\nDup,one@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws1", parsed, mode: "quick" });
    await verifyBatchProcessor(repo, dns, { workspaceId: "ws1", batchId: batch.id });
    const csv = await exportBatchProcessor(repo, { workspaceId: "ws1", batchId: batch.id });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("name,email,mailcheckr_status,mailcheckr_confidence,mailcheckr_reason_codes");
    expect(lines[1]).toContain("'=2+5"); // formula injection escaped
    expect(lines[2]).toContain("likely_valid");
    expect(lines[3]).toContain("duplicate");
  });
  it("deep mode with gate off annotates smtp_port_unavailable and never returns valid", async () => {
    const repo = new InMemoryWorkerRepository();
    const parsed = await parseCsvText("email\none@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws1", parsed, mode: "deep" });
    await verifyBatchProcessor(repo, dns, { workspaceId: "ws1", batchId: batch.id, deepEnabled: false });
    const records = await repo.listRecords("ws1", batch.id);
    expect(records[0].status).toBe("likely_valid");
    expect(records[0].reasonCodes).toContain("smtp_port_unavailable");
  });
  it("scheduler expiry marks batch expired and deletes records; re-run is a no-op", async () => {
    const repo = new InMemoryWorkerRepository();
    const parsed = await parseCsvText("email\none@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "ws1", parsed, mode: "quick", retentionDays: 7 });
    await verifyBatchProcessor(repo, dns, { workspaceId: "ws1", batchId: batch.id });
    await repo.updateBatch("ws1", batch.id, { expiresAt: new Date(Date.now() - 1000) });
    const res = await expireBatchesProcessor(repo, new Date());
    expect(res.expired).toBe(1);
    expect((await repo.getBatch("ws1", batch.id))?.status).toBe("expired");
    expect((await repo.listRecords("ws1", batch.id)).length).toBe(0);
    expect((await expireBatchesProcessor(repo, new Date())).expired).toBe(0);
  });
  it("tenant isolation: worker repo scopes batches by workspace", async () => {
    const repo = new InMemoryWorkerRepository();
    const parsed = await parseCsvText("email\none@example.com\n");
    const batch = await bulkParseProcessor(repo, { workspaceId: "wsA", parsed, mode: "quick" });
    expect(await repo.getBatch("wsB", batch.id)).toBeNull();
    await expect(verifyBatchProcessor(repo, dns, { workspaceId: "wsB", batchId: batch.id })).rejects.toThrow("BATCH_NOT_FOUND");
  });
});
