import { randomUUID } from "node:crypto";

/** Worker-side repository contract — same shapes/semantics as the API's
 * Repository (apps/api/src/repositories) so processors are testable against
 * this in-memory implementation and run against Prisma in production via
 * the adapter in src/prisma-repository.ts. */
export interface BatchData {
  id: string; workspaceId: string; mode: "quick" | "deep";
  status: "created" | "queued" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled" | "expired";
  rowCount: number; uniqueCount: number; duplicateCount: number; completedCount: number;
  invalidCount: number; riskyCount: number; unknownCount: number;
  creditsReserved: number; creditsCharged: number; creditsRefunded: number;
  emailColumnName: string | null; originalColumns: string[];
  startedAt: Date | null; completedAt: Date | null; expiresAt: Date | null; createdAt: Date;
}
export interface RowData { id: string; batchId: string; rowNumber: number; original: Record<string, string>; email: string; isDuplicate: boolean; duplicateOfRowNumber: number | null; emailRecordId: string | null; parseErrorCode: string | null; }
export interface RecordData { id: string; workspaceId: string; batchId: string; rowNumber: number; email: string; domain: string; status: string; confidence: string; reasonCodes: string[]; createdAt: Date; }
export interface LedgerData { id: string; workspaceId: string; batchId: string | null; recordId: string | null; entryType: string; quantity: number; idempotencyKey: string; createdAt: Date; }

export interface WorkerRepository {
  createBatch(d: Omit<BatchData, "id" | "createdAt">): Promise<BatchData>;
  getBatch(workspaceId: string, id: string): Promise<BatchData | null>;
  updateBatch(workspaceId: string, id: string, patch: Partial<BatchData>): Promise<BatchData | null>;
  addRow(d: Omit<RowData, "id">): Promise<RowData>;
  listRows(batchId: string): Promise<RowData[]>;
  addRecord(d: Omit<RecordData, "id" | "createdAt">): Promise<RecordData>;
  listRecords(workspaceId: string, batchId: string): Promise<RecordData[]>;
  deleteRecords(workspaceId: string, batchId: string): Promise<void>;
  addLedger(d: Omit<LedgerData, "id" | "createdAt">): Promise<LedgerData>;
  findLedgerByKey(key: string): Promise<LedgerData | null>;
  sumLedger(workspaceId: string): Promise<number>;
  listLedger(workspaceId: string): Promise<LedgerData[]>;
  listExpiredBatches(now: Date): Promise<BatchData[]>;
}

export class InMemoryWorkerRepository implements WorkerRepository {
  batches = new Map<string, BatchData>(); rows = new Map<string, RowData>();
  records = new Map<string, RecordData>(); ledger = new Map<string, LedgerData>();
  async createBatch(d: any) { const b = { id: randomUUID(), createdAt: new Date(), ...d }; this.batches.set(b.id, b); return b; }
  async getBatch(workspaceId: string, id: string) { const b = this.batches.get(id); return b && b.workspaceId === workspaceId ? b : null; }
  async updateBatch(workspaceId: string, id: string, patch: any) { const b = await this.getBatch(workspaceId, id); if (!b) return null; Object.assign(b, patch); return b; }
  async addRow(d: any) { const r = { id: randomUUID(), ...d }; this.rows.set(r.id, r); return r; }
  async listRows(batchId: string) { return [...this.rows.values()].filter((r) => r.batchId === batchId).sort((a, b) => a.rowNumber - b.rowNumber); }
  async addRecord(d: any) { const r = { id: randomUUID(), createdAt: new Date(), ...d }; this.records.set(r.id, r); return r; }
  async listRecords(workspaceId: string, batchId: string) { return [...this.records.values()].filter((r) => r.workspaceId === workspaceId && r.batchId === batchId).sort((a, b) => a.rowNumber - b.rowNumber); }
  async deleteRecords(workspaceId: string, batchId: string) { for (const [id, r] of this.records) if (r.workspaceId === workspaceId && r.batchId === batchId) this.records.delete(id); }
  async addLedger(d: any) { const existing = await this.findLedgerByKey(d.idempotencyKey); if (existing) return existing; const e = { id: randomUUID(), createdAt: new Date(), ...d }; this.ledger.set(e.id, e); return e; }
  async findLedgerByKey(key: string) { return [...this.ledger.values()].find((e) => e.idempotencyKey === key) ?? null; }
  async sumLedger(workspaceId: string) { return [...this.ledger.values()].filter((e) => e.workspaceId === workspaceId).reduce((s, e) => s + e.quantity, 0); }
  async listLedger(workspaceId: string) { return [...this.ledger.values()].filter((e) => e.workspaceId === workspaceId); }
  async listExpiredBatches(now: Date) { return [...this.batches.values()].filter((b) => b.expiresAt && b.expiresAt.getTime() <= now.getTime() && !["expired", "cancelled"].includes(b.status)); }
}
