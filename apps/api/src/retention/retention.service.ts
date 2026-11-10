import { Inject, Injectable } from "@nestjs/common";
import { REPOSITORY, type Repository } from "../repositories/repository";

/**
 * Retention & verified deletion (PRD §10.2).
 * - purgeExpired(): batches past expires_at lose their records/rows and are
 *   marked expired; ledger links are severed (amounts kept for accounting —
 *   the ledger itself holds no email personal data).
 * - purgeBatch(): the user-initiated DELETE path — removes the batch, its
 *   verification records and batch rows, severs ledger links, and writes an
 *   audit event. Returns counts so callers/tests can verify the purge.
 */
@Injectable()
export class RetentionService {
  constructor(@Inject(REPOSITORY) private readonly repo: Repository) {}

  async purgeBatch(workspaceId: string, batchId: string, actorId?: string | null): Promise<{ deleted: boolean; recordsRemoved: number }> {
    const batch = await this.repo.findBatchById(workspaceId, batchId);
    if (!batch) return { deleted: false, recordsRemoved: 0 };
    const records = await this.repo.listAllRecordsByBatch(workspaceId, batchId);
    await this.repo.anonymizeLedgerForBatch(batchId);
    await this.repo.deleteBatch(workspaceId, batchId); // cascades records + rows in both implementations
    await this.repo.createAudit({ workspaceId, actorId: actorId ?? null, action: "batch.purge", resourceType: "batch", resourceId: batchId, metadata: { recordsRemoved: records.length, reason: "user_delete" } });
    return { deleted: true, recordsRemoved: records.length };
  }

  async purgeExpired(now = new Date()): Promise<{ expired: number }> {
    const batches = await this.repo.listExpiredBatches(now);
    for (const b of batches) {
      await this.repo.anonymizeLedgerForBatch(b.id);
      await this.repo.deleteRecordsByBatch(b.workspaceId, b.id);
      await this.repo.updateBatch(b.workspaceId, b.id, { status: "expired" });
      await this.repo.createAudit({ workspaceId: b.workspaceId, actorId: null, action: "batch.expire", resourceType: "batch", resourceId: b.id, metadata: { reason: "retention_window_elapsed" } });
    }
    return { expired: batches.length };
  }
}
