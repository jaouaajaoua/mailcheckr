import type { Repository } from "./repository";

/**
 * Production repository backed by Prisma/PostgreSQL (schema in
 * @mailcheckr/database). All queries are scoped by workspaceId
 * (tenant isolation, PRD §7).
 *
 * The Prisma client is loaded LAZILY (in the constructor, not via a static
 * top-level import) on purpose:
 *  - AppModule imports this class statically but only *instantiates* it when
 *    DATABASE_URL is set; a static import of "@prisma/client" would make
 *    every unit test and every DB-less boot depend on a generated client.
 *  - "@prisma/client" IS a declared dependency of @mailcheckr/api
 *    (apps/api/package.json, version aligned with packages/database) — the
 *    laziness is about *when* it loads, not about it being optional.
 *    apps/api/test/prisma-runtime.test.ts guards the declaration.
 */
export class PrismaRepository implements Repository {
  private client: any;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require("@prisma/client");
    this.client = new PrismaClient();
  }
  private get db() { return this.client; }

  async createUser(d: any) { return this.db.user.create({ data: d }); }
  async findUserByEmail(email: string) { return this.db.user.findFirst({ where: { email, deletedAt: null } }); }
  async findUserById(id: string) { return this.db.user.findUnique({ where: { id } }); }
  async updateUserPassword(userId: string, passwordHash: string) { await this.db.user.update({ where: { id: userId }, data: { passwordHash } }); }
  async createWorkspace(d: any) { return this.db.workspace.create({ data: d }); }
  async findWorkspaceById(id: string) { return this.db.workspace.findUnique({ where: { id } }); }
  async findWorkspaceByOwner(userId: string) { return this.db.workspace.findFirst({ where: { ownerUserId: userId } }); }
  async createResetToken(d: any) { return this.db.passwordResetToken.create({ data: d }); }
  async findResetTokenByHash(tokenHash: string) { return this.db.passwordResetToken.findUnique({ where: { tokenHash } }); }
  async markResetTokenUsed(id: string) { await this.db.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } }); }
  async createApiKey(d: any) { const k = await this.db.apiKey.create({ data: { ...d, scopes: d.scopes } }); return { ...k, scopes: k.scopes as string[] }; }
  async listApiKeys(workspaceId: string) { const rows = await this.db.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }); return rows.map((k: any) => ({ ...k, scopes: k.scopes as string[] })); }
  async findApiKeysByPrefix(prefix: string) { const rows = await this.db.apiKey.findMany({ where: { keyPrefix: prefix } }); return rows.map((k: any) => ({ ...k, scopes: k.scopes as string[] })); }
  async findApiKeyById(workspaceId: string, id: string) { const k = await this.db.apiKey.findFirst({ where: { id, workspaceId } }); return k ? { ...k, scopes: k.scopes as string[] } : null; }
  async revokeApiKey(workspaceId: string, id: string) { const existing = await this.findApiKeyById(workspaceId, id); if (!existing) return null; const k = await this.db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }); return { ...k, scopes: k.scopes as string[] }; }
  async touchApiKey(id: string) { await this.db.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }); }
  async createBatch(d: any) { return this.db.verificationBatch.create({ data: d }); }
  async listBatches(workspaceId: string, opts: { limit: number; offset?: number }) { return this.db.verificationBatch.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: opts.limit, skip: opts.offset ?? 0 }); }
  async findBatchById(workspaceId: string, id: string) { return this.db.verificationBatch.findFirst({ where: { id, workspaceId } }); }
  async findBatchByIdempotencyKey(workspaceId: string, key: string) { return this.db.verificationBatch.findFirst({ where: { workspaceId, idempotencyKey: key } }); }
  async updateBatch(workspaceId: string, id: string, patch: any) { const b = await this.findBatchById(workspaceId, id); if (!b) return null; return this.db.verificationBatch.update({ where: { id }, data: patch }); }
  async deleteBatch(workspaceId: string, id: string) { const b = await this.findBatchById(workspaceId, id); if (!b) return false; await this.db.verificationBatch.delete({ where: { id } }); return true; }
  async createRecord(d: any) { return this.db.verificationRecord.create({ data: d }); }
  async findRecordByIdempotencyKey(workspaceId: string, key: string) { return this.db.verificationRecord.findFirst({ where: { workspaceId, idempotencyKey: key } }); }
  async listRecordsByBatch(workspaceId: string, batchId: string, opts: { cursorRow?: number; limit: number; status?: string }) {
    return this.db.verificationRecord.findMany({
      where: { workspaceId, batchId, ...(opts.status ? { status: opts.status as any } : {}), ...(opts.cursorRow != null ? { rowNumber: { gt: opts.cursorRow } } : {}) },
      orderBy: { rowNumber: "asc" }, take: opts.limit,
    });
  }
  async listAllRecordsByBatch(workspaceId: string, batchId: string) { return this.db.verificationRecord.findMany({ where: { workspaceId, batchId }, orderBy: { rowNumber: "asc" } }); }
  async listRecentRecords(workspaceId: string, opts: { limit: number; singleOnly?: boolean }) {
    return this.db.verificationRecord.findMany({
      where: { workspaceId, ...(opts.singleOnly ? { batchId: null } : {}) },
      orderBy: { checkedAt: "desc" }, take: opts.limit,
    });
  }
  async countRecords(workspaceId: string) { return this.db.verificationRecord.count({ where: { workspaceId } }); }
  async countRecordsSince(workspaceId: string, since: Date) { return this.db.verificationRecord.count({ where: { workspaceId, createdAt: { gte: since } } }); }
  async createBatchRow(d: any) { const { originalEmail, ...rest } = d; return this.db.batchRow.create({ data: { ...rest, originalRowRef: originalEmail ?? null } }); }
  async listBatchRows(batchId: string) { const rows = await this.db.batchRow.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } }); return rows.map((r: any) => ({ ...r, originalEmail: r.originalRowRef })); }
  async deleteRecordsByBatch(workspaceId: string, batchId: string) { await this.db.verificationRecord.deleteMany({ where: { workspaceId, batchId } }); }
  async createLedgerEntry(d: any) {
    const existing = await this.findLedgerByIdempotencyKey(d.idempotencyKey);
    if (existing) return existing;
    return this.db.creditLedger.create({ data: d });
  }
  async findLedgerByIdempotencyKey(key: string) { return this.db.creditLedger.findUnique({ where: { idempotencyKey: key } }); }
  async listLedger(workspaceId: string, opts: { limit: number; offset: number }) { return this.db.creditLedger.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: opts.limit, skip: opts.offset }); }
  async sumLedger(workspaceId: string) { const agg = await this.db.creditLedger.aggregate({ where: { workspaceId }, _sum: { quantity: true } }); return agg._sum.quantity ?? 0; }
  async listExpiredBatches(now: Date) { return this.db.verificationBatch.findMany({ where: { expiresAt: { lte: now }, status: { notIn: ["expired", "cancelled"] } } }); }
  async anonymizeLedgerForBatch(batchId: string) { await this.db.creditLedger.updateMany({ where: { batchId }, data: { batchId: null, verificationRecordId: null } }); }
  async createAudit(d: any) { return this.db.auditEvent.create({ data: d }); }
  async purgeWorkspace(workspaceId: string, ownerUserId: string) {
    const [batchesRemoved, recordsRemoved, apiKeysRemoved, ledgerEntriesRetained] = await Promise.all([
      this.db.verificationBatch.count({ where: { workspaceId } }),
      this.db.verificationRecord.count({ where: { workspaceId } }),
      this.db.apiKey.count({ where: { workspaceId } }),
      this.db.creditLedger.count({ where: { workspaceId } }),
    ]);
    // Sever ledger links to personal-data-bearing rows first; the entries and
    // amounts themselves are retained — credit_ledger.workspace_id is nullable
    // with ON DELETE SET NULL (migration 20261110010000) precisely so the
    // accounting record survives the workspace it belonged to.
    await this.db.creditLedger.updateMany({ where: { workspaceId }, data: { batchId: null, verificationRecordId: null } });
    // Batches cascade to their records/rows; single-check records (batch_id
    // NULL) and the remaining tenant rows are deleted explicitly.
    await this.db.verificationBatch.deleteMany({ where: { workspaceId } });
    await this.db.verificationRecord.deleteMany({ where: { workspaceId } });
    await this.db.apiKey.deleteMany({ where: { workspaceId } });
    await this.db.webhookEndpoint.deleteMany({ where: { workspaceId } });
    // Workspace delete SET NULLs the retained ledger rows + audit events.
    await this.db.workspace.delete({ where: { id: workspaceId } });
    // User delete cascades password reset tokens.
    await this.db.user.delete({ where: { id: ownerUserId } });
    return { batchesRemoved, recordsRemoved, apiKeysRemoved, ledgerEntriesRetained };
  }
}
