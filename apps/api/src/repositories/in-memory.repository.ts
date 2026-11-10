import { randomUUID } from "node:crypto";
import type { ApiKeyRow, AuditRow, BatchRowData, BatchRowRow, LedgerRow, RecordRow, Repository, ResetTokenRow, UserRow, WorkspaceRow } from "./repository";

/** Full in-memory implementation of the Repository contract. Used for tests and
 * for local dev when DATABASE_URL is unset. Behaviour (tenant scoping,
 * idempotency uniqueness, ordering) mirrors the Prisma implementation. */
export class InMemoryRepository implements Repository {
  users = new Map<string, UserRow>();
  workspaces = new Map<string, WorkspaceRow>();
  apiKeys = new Map<string, ApiKeyRow>();
  batches = new Map<string, BatchRowData>();
  records = new Map<string, RecordRow>();
  batchRows = new Map<string, BatchRowRow>();
  ledger = new Map<string, LedgerRow>();
  resetTokens = new Map<string, ResetTokenRow>();
  audits: AuditRow[] = [];

  async createUser(d: any) { const u = { id: randomUUID(), createdAt: new Date(), deletedAt: null, emailVerifiedAt: d.emailVerifiedAt ?? null, ...d }; this.users.set(u.id, u); return u; }
  async findUserByEmail(email: string) { return [...this.users.values()].find((u) => u.email === email && !u.deletedAt) ?? null; }
  async findUserById(id: string) { return this.users.get(id) ?? null; }
  async updateUserPassword(userId: string, passwordHash: string) { const u = this.users.get(userId); if (u) u.passwordHash = passwordHash; }
  async createWorkspace(d: any) { const ws = { id: randomUUID(), planCode: "free", createdAt: new Date(), ...d }; this.workspaces.set(ws.id, ws); return ws; }
  async findWorkspaceById(id: string) { return this.workspaces.get(id) ?? null; }
  async findWorkspaceByOwner(userId: string) { return [...this.workspaces.values()].find((w) => w.ownerUserId === userId) ?? null; }
  async createResetToken(d: any) { const t = { id: randomUUID(), usedAt: null, createdAt: new Date(), ...d }; this.resetTokens.set(t.id, t); return t; }
  async findResetTokenByHash(h: string) { return [...this.resetTokens.values()].find((t) => t.tokenHash === h) ?? null; }
  async markResetTokenUsed(id: string) { const t = this.resetTokens.get(id); if (t) t.usedAt = new Date(); }
  async createApiKey(d: any) { const k = { id: randomUUID(), createdAt: new Date(), lastUsedAt: d.lastUsedAt ?? null, revokedAt: d.revokedAt ?? null, ...d }; this.apiKeys.set(k.id, k); return k; }
  async listApiKeys(workspaceId: string) { return [...this.apiKeys.values()].filter((k) => k.workspaceId === workspaceId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); }
  async findApiKeysByPrefix(prefix: string) { return [...this.apiKeys.values()].filter((k) => k.keyPrefix === prefix); }
  async findApiKeyById(workspaceId: string, id: string) { const k = this.apiKeys.get(id); return k && k.workspaceId === workspaceId ? k : null; }
  async revokeApiKey(workspaceId: string, id: string) { const k = await this.findApiKeyById(workspaceId, id); if (!k) return null; k.revokedAt = new Date(); return k; }
  async touchApiKey(id: string) { const k = this.apiKeys.get(id); if (k) k.lastUsedAt = new Date(); }
  async createBatch(d: any) { const b = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), name: null, ...d }; this.batches.set(b.id, b); return b; }
  async listBatches(workspaceId: string, opts: { limit: number; offset?: number }) {
    return [...this.batches.values()].filter((b) => b.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit);
  }
  async findBatchById(workspaceId: string, id: string) { const b = this.batches.get(id); return b && b.workspaceId === workspaceId ? b : null; }
  async findBatchByIdempotencyKey(workspaceId: string, key: string) { return [...this.batches.values()].find((b) => b.workspaceId === workspaceId && b.idempotencyKey === key) ?? null; }
  async updateBatch(workspaceId: string, id: string, patch: any) { const b = await this.findBatchById(workspaceId, id); if (!b) return null; Object.assign(b, patch, { updatedAt: new Date() }); return b; }
  async deleteBatch(workspaceId: string, id: string) { const b = await this.findBatchById(workspaceId, id); if (!b) return false; this.batches.delete(id); for (const [rid, r] of this.records) if (r.batchId === id) this.records.delete(rid); for (const [rid, r] of this.batchRows) if (r.batchId === id) this.batchRows.delete(rid); return true; }
  async createRecord(d: any) { const r = { id: randomUUID(), createdAt: new Date(), ...d }; this.records.set(r.id, r); return r; }
  async findRecordByIdempotencyKey(workspaceId: string, key: string) { return [...this.records.values()].find((r) => r.workspaceId === workspaceId && r.idempotencyKey === key) ?? null; }
  async listRecordsByBatch(workspaceId: string, batchId: string, opts: { cursorRow?: number; limit: number; status?: string }) {
    let rows = [...this.records.values()].filter((r) => r.workspaceId === workspaceId && r.batchId === batchId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    rows.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0));
    if (opts.cursorRow != null) rows = rows.filter((r) => (r.rowNumber ?? 0) > opts.cursorRow!);
    return rows.slice(0, opts.limit);
  }
  async listAllRecordsByBatch(workspaceId: string, batchId: string) { return this.listRecordsByBatch(workspaceId, batchId, { limit: Number.MAX_SAFE_INTEGER }); }
  async listRecentRecords(workspaceId: string, opts: { limit: number; singleOnly?: boolean }) {
    let rows = [...this.records.values()].filter((r) => r.workspaceId === workspaceId);
    if (opts.singleOnly) rows = rows.filter((r) => r.batchId === null);
    rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    return rows.slice(0, opts.limit);
  }
  async countRecords(workspaceId: string) { return [...this.records.values()].filter((r) => r.workspaceId === workspaceId).length; }
  async countRecordsSince(workspaceId: string, since: Date) { return [...this.records.values()].filter((r) => r.workspaceId === workspaceId && r.createdAt.getTime() >= since.getTime()).length; }
  async createBatchRow(d: any) { const r = { id: randomUUID(), ...d }; this.batchRows.set(r.id, r); return r; }
  async listBatchRows(batchId: string) { return [...this.batchRows.values()].filter((r) => r.batchId === batchId).sort((a, b) => a.rowNumber - b.rowNumber); }
  async deleteRecordsByBatch(workspaceId: string, batchId: string) { for (const [id, r] of this.records) if (r.workspaceId === workspaceId && r.batchId === batchId) this.records.delete(id); }
  async createLedgerEntry(d: any) {
    const existing = await this.findLedgerByIdempotencyKey(d.idempotencyKey);
    if (existing) return existing; // unique idempotency_key — retried mutation is a no-op
    const e = { id: randomUUID(), createdAt: new Date(), ...d }; this.ledger.set(e.id, e); return e;
  }
  async findLedgerByIdempotencyKey(key: string) { return [...this.ledger.values()].find((e) => e.idempotencyKey === key) ?? null; }
  async listLedger(workspaceId: string, opts: { limit: number; offset: number }) {
    return [...this.ledger.values()].filter((e) => e.workspaceId === workspaceId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(opts.offset, opts.offset + opts.limit);
  }
  async sumLedger(workspaceId: string) { return [...this.ledger.values()].filter((e) => e.workspaceId === workspaceId).reduce((s, e) => s + e.quantity, 0); }
  async listExpiredBatches(now: Date) { return [...this.batches.values()].filter((b) => b.expiresAt && b.expiresAt.getTime() <= now.getTime() && !["expired", "cancelled"].includes(b.status)); }
  async anonymizeLedgerForBatch(batchId: string) { for (const e of this.ledger.values()) if (e.batchId === batchId) { e.batchId = null; e.verificationRecordId = null; } }
  async createAudit(d: any) { const a = { id: randomUUID(), createdAt: new Date(), ...d }; this.audits.push(a); return a; }
  async purgeWorkspace(workspaceId: string, ownerUserId: string) {
    const batches = [...this.batches.values()].filter((b) => b.workspaceId === workspaceId);
    const batchIds = new Set(batches.map((b) => b.id));
    const recordsRemoved = [...this.records.values()].filter((r) => r.workspaceId === workspaceId).length;
    const apiKeysRemoved = [...this.apiKeys.values()].filter((k) => k.workspaceId === workspaceId).length;
    let ledgerEntriesRetained = 0;
    // Ledger entries are the accounting record: keep them and their amounts,
    // severing only the links to purged batches/records (personal-data refs).
    for (const e of this.ledger.values()) if (e.workspaceId === workspaceId) { e.batchId = null; e.verificationRecordId = null; ledgerEntriesRetained++; }
    for (const [id, r] of this.records) if (r.workspaceId === workspaceId) this.records.delete(id);
    for (const [id, r] of this.batchRows) if (batchIds.has(r.batchId)) this.batchRows.delete(id);
    for (const id of batchIds) this.batches.delete(id);
    for (const [id, k] of this.apiKeys) if (k.workspaceId === workspaceId) this.apiKeys.delete(id);
    for (const [id, t] of this.resetTokens) if (t.userId === ownerUserId) this.resetTokens.delete(id);
    this.workspaces.delete(workspaceId);
    this.users.delete(ownerUserId);
    return { batchesRemoved: batches.length, recordsRemoved, apiKeysRemoved, ledgerEntriesRetained };
  }
}
