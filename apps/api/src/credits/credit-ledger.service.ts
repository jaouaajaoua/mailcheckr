import { ApiError } from "../common/errors";
import type { CreditEntryType, LedgerRow, Repository } from "../repositories/repository";

/**
 * Credit accounting (PRD §9). All mutations go through the immutable ledger
 * with a unique idempotency key; balance is the SUM of signed quantities
 * (grants/purchases/refunds/releases positive, reserves/charges negative).
 * Rules: unknown outcomes are NOT charged; duplicates are NOT charged;
 * parsing failures are NOT charged; cancelled jobs release their reservation.
 * This class is pure logic over the Repository interface — unit-testable
 * without Nest, HTTP, Postgres, or Redis.
 */
export class CreditLedgerService {
  constructor(private readonly repo: Repository) {}

  async balance(workspaceId: string): Promise<number> { return this.repo.sumLedger(workspaceId); }

  private async apply(input: { workspaceId: string; entryType: CreditEntryType; quantity: number; idempotencyKey: string; batchId?: string | null; verificationRecordId?: string | null; description?: string }): Promise<LedgerRow> {
    const existing = await this.repo.findLedgerByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing; // idempotent retry — never double-apply
    return this.repo.createLedgerEntry({
      workspaceId: input.workspaceId, entryType: input.entryType, quantity: input.quantity,
      idempotencyKey: input.idempotencyKey, batchId: input.batchId ?? null,
      verificationRecordId: input.verificationRecordId ?? null, description: input.description ?? null,
    });
  }

  grant(workspaceId: string, quantity: number, idempotencyKey: string, description = "Credit grant") {
    return this.apply({ workspaceId, entryType: "grant", quantity: Math.abs(quantity), idempotencyKey, description });
  }
  async reserve(workspaceId: string, quantity: number, batchId: string, idempotencyKey: string) {
    if (quantity <= 0) return null;
    const existing = await this.repo.findLedgerByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    const bal = await this.balance(workspaceId);
    if (bal < quantity) throw new ApiError("INSUFFICIENT_CREDITS", `Insufficient credits: need ${quantity}, have ${bal}.`, 402);
    return this.apply({ workspaceId, entryType: "reserve", quantity: -quantity, idempotencyKey, batchId, description: "Batch credit reservation" });
  }
  /** Charge one completed verification. Unknown outcomes are refused here as a hard invariant. */
  async chargeForVerification(input: { workspaceId: string; recordId: string; batchId?: string | null; status: string; idempotencyKey: string }) {
    if (input.status === "unknown") return null; // PRD §9: unknown is never charged
    return this.apply({ workspaceId: input.workspaceId, entryType: "charge", quantity: -1, idempotencyKey: input.idempotencyKey, batchId: input.batchId ?? null, verificationRecordId: input.recordId, description: "Verification charge" });
  }
  release(workspaceId: string, quantity: number, batchId: string, idempotencyKey: string, description = "Release unused reserved credits") {
    if (quantity <= 0) return Promise.resolve(null);
    return this.apply({ workspaceId, entryType: "release", quantity: Math.abs(quantity), idempotencyKey, batchId, description });
  }
  refund(workspaceId: string, quantity: number, idempotencyKey: string, opts: { batchId?: string | null; recordId?: string | null } = {}) {
    if (quantity <= 0) return Promise.resolve(null);
    return this.apply({ workspaceId, entryType: "refund", quantity: Math.abs(quantity), idempotencyKey, batchId: opts.batchId ?? null, verificationRecordId: opts.recordId ?? null, description: "Credit refund" });
  }
  list(workspaceId: string, limit = 50, offset = 0) { return this.repo.listLedger(workspaceId, { limit, offset }); }
}
