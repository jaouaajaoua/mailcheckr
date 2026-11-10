import type { WorkerRepository } from "./repositories";

/** Ledger settlement shared by worker processors (mirrors PRD §9 rules and the
 * API CreditLedgerService): idempotency-keyed, unknown never charged,
 * duplicates never reach this layer. */
export async function ledgerApply(repo: WorkerRepository, d: { workspaceId: string; entryType: string; quantity: number; idempotencyKey: string; batchId?: string | null; recordId?: string | null }) {
  const existing = await repo.findLedgerByKey(d.idempotencyKey);
  if (existing) return existing;
  return repo.addLedger({ workspaceId: d.workspaceId, entryType: d.entryType, quantity: d.quantity, idempotencyKey: d.idempotencyKey, batchId: d.batchId ?? null, recordId: d.recordId ?? null });
}
export async function chargeForResult(repo: WorkerRepository, input: { workspaceId: string; batchId: string; recordId: string; status: string }) {
  if (input.status === "unknown") return null; // PRD §9: unknown is not charged
  return ledgerApply(repo, { workspaceId: input.workspaceId, entryType: "charge", quantity: -1, idempotencyKey: `charge:record:${input.recordId}`, batchId: input.batchId, recordId: input.recordId });
}
