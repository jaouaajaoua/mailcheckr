import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { decryptValue, encryptValue, hmacDigest } from "../common/crypto";
import { APP_CONFIG, REPOSITORY, type Repository } from "../repositories/repository";
import { CreditLedgerService } from "../credits/credit-ledger.service";
import { VerificationService } from "../verification/verification.service";

export const MAX_JSON_BATCH = 1000;

/** CSV formula-injection escaping (PRD §10.4): prefix dangerous leading chars. */
export function escapeCsvCell(value: string): string {
  let v = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

@Injectable()
export class BatchesService {
  private credits: CreditLedgerService;
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(APP_CONFIG) private readonly config: any,
    @Inject(VerificationService) private readonly verifier: VerificationService,
  ) { this.credits = new CreditLedgerService(repo); }

  private get deepEnabled() { return this.config.SMTP_DEEP_ENABLED === true && this.config.SMTP_EGRESS_APPROVED === true; }

  async createBatch(input: { workspaceId: string; userId: string | null; name?: string | null; emails: string[]; mode: "quick" | "deep"; sourceType?: "api" | "paste"; idempotencyKey?: string }) {
    if (!Array.isArray(input.emails) || input.emails.length === 0) throw new ApiError("VALIDATION_ERROR", "emails must be a non-empty array.", 422);
    if (input.emails.length > MAX_JSON_BATCH) throw new ApiError("PAYLOAD_TOO_LARGE", `JSON batches are capped at ${MAX_JSON_BATCH} emails. Use CSV upload for larger lists.`, 413);
    if (input.idempotencyKey) {
      const existing = await this.repo.findBatchByIdempotencyKey(input.workspaceId, input.idempotencyKey);
      if (existing) return this.present(existing);
    }
    // Dedupe by normalized address (trim + domain lowercase / punycode via parse in verifier pipeline).
    const seen = new Map<string, number>(); // normalizedKey -> first rowNumber
    const uniques: { rowNumber: number; email: string; key: string }[] = [];
    const rows: { rowNumber: number; email: string; isDuplicate: boolean; duplicateOfRowNumber: number | null }[] = [];
    input.emails.forEach((raw, i) => {
      const rowNumber = i + 1;
      const trimmed = String(raw ?? "").trim();
      const at = trimmed.lastIndexOf("@");
      const key = at > 0 ? `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}` : trimmed.toLowerCase();
      if (seen.has(key)) rows.push({ rowNumber, email: trimmed, isDuplicate: true, duplicateOfRowNumber: seen.get(key)! });
      else { seen.set(key, rowNumber); uniques.push({ rowNumber, email: trimmed, key }); rows.push({ rowNumber, email: trimmed, isDuplicate: false, duplicateOfRowNumber: null }); }
    });

    const batch = await this.repo.createBatch({
      workspaceId: input.workspaceId, createdByUserId: input.userId, name: input.name ?? null, sourceType: input.sourceType ?? "api",
      originalFilename: null, emailColumnName: null, mode: input.mode, status: "queued",
      rowCount: input.emails.length, uniqueCount: uniques.length, duplicateCount: rows.filter((r) => r.isDuplicate).length,
      completedCount: 0, invalidCount: 0, riskyCount: 0, unknownCount: 0,
      creditsReserved: 0, creditsCharged: 0, creditsRefunded: 0,
      idempotencyKey: input.idempotencyKey ?? null, startedAt: null, completedAt: null,
      expiresAt: new Date(Date.now() + (this.config.RESULT_RETENTION_DAYS ?? 7) * 86400_000),
    });
    // Reserve for unique rows only — duplicates are never charged (PRD §9).
    await this.credits.reserve(input.workspaceId, uniques.length, batch.id, `reserve:batch:${batch.id}`);
    await this.repo.updateBatch(input.workspaceId, batch.id, { creditsReserved: uniques.length });
    for (const r of rows) {
      await this.repo.createBatchRow({ batchId: batch.id, rowNumber: r.rowNumber, emailRecordId: null, isDuplicate: r.isDuplicate, duplicateOfRowNumber: r.duplicateOfRowNumber, parseErrorCode: null, originalEmail: r.email });
    }
    // Queued for the BullMQ worker; processInline() is the same code path the
    // worker processors use, exposed here for the API-only/dev runtime.
    return this.present((await this.repo.findBatchById(input.workspaceId, batch.id))!);
  }

  /** Verify all unique rows, persist records, settle credits. Idempotent:
   *  re-running a completed batch is a no-op; per-record charge keys make
   *  partial re-runs safe after a crash (PRD §11). */
  async processInline(workspaceId: string, batchId: string) {
    const batch = await this.repo.findBatchById(workspaceId, batchId);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    if (batch.status === "completed" || batch.status === "completed_with_errors" || batch.status === "cancelled") return this.present(batch);
    await this.repo.updateBatch(workspaceId, batchId, { status: "processing", startedAt: batch.startedAt ?? new Date() });
    const rows = await this.repo.listBatchRows(batchId);
    const existing = await this.repo.listAllRecordsByBatch(workspaceId, batchId);
    const doneRows = new Set(existing.map((r) => r.rowNumber));
    let charged = 0, invalid = 0, risky = 0, unknown = 0, completed = existing.length;
    for (const rec of existing) { if (rec.status === "invalid") invalid++; else if (rec.status === "risky") risky++; else if (rec.status === "unknown") unknown++; }
    charged = existing.filter((r) => r.status !== "unknown").length;
    const uniqueRows = rows.filter((r) => !r.isDuplicate);
    for (const row of uniqueRows) {
      if (doneRows.has(row.rowNumber)) continue;
      const result = await this.verifier.verify(row.originalEmail ?? "", batch.mode, { deepEnabled: this.deepEnabled });
      const record = await this.repo.createRecord({
        workspaceId, batchId, emailCiphertext: encryptValue(result.email, this.config.ENCRYPTION_KEY),
        emailHmac: hmacDigest(result.email, this.config.HMAC_KEY), domainNormalized: result.domain,
        rowNumber: row.rowNumber, status: result.status, mode: result.mode, confidence: result.confidence,
        reasonCodes: result.reasonCodes, checksPerformed: result.checks as unknown as Record<string, unknown>, dnsEvidence: result.dnsEvidence,
        smtpEvidence: result.smtpEvidence, idempotencyKey: `record:batch:${batchId}:row:${row.rowNumber}`,
        checkedAt: new Date(result.checkedAt), expiresAt: batch.expiresAt,
      });
      row.emailRecordId = record.id;
      // Settlement: charge billable results only. Reserve is fully released at
      // completion below (reserve -N, release +N, charges -billable).
      if (result.billable && result.status !== "unknown") {
        await this.credits.chargeForVerification({ workspaceId, recordId: record.id, batchId, status: result.status, idempotencyKey: `charge:record:${record.id}` });
        charged++;
      }
      if (result.status === "invalid") invalid++; else if (result.status === "risky") risky++; else if (result.status === "unknown") unknown++;
      completed++;
    }
    await this.credits.release(workspaceId, batch.creditsReserved, batchId, `release:batch:${batchId}`, "Release batch reservation at completion");
    const updated = await this.repo.updateBatch(workspaceId, batchId, {
      status: "completed", completedCount: completed, invalidCount: invalid, riskyCount: risky, unknownCount: unknown,
      creditsCharged: charged, completedAt: new Date(),
    });
    return this.present(updated!);
  }

  /** Workspace batch list for GET /v1/batches — newest first, tenant-scoped
   *  at the repository (workspaceId from the auth context only). */
  async listBatches(workspaceId: string, opts: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = await this.repo.listBatches(workspaceId, { limit, offset });
    return { data: rows.map((b) => this.present(b)) };
  }

  async getBatch(workspaceId: string, id: string) {
    const batch = await this.repo.findBatchById(workspaceId, id);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    return this.present(batch);
  }

  async getResults(workspaceId: string, id: string, opts: { cursor?: string; limit?: number; status?: string }) {
    const batch = await this.repo.findBatchById(workspaceId, id);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const cursorRow = opts.cursor ? Number(Buffer.from(opts.cursor, "base64url").toString("utf8")) : undefined;
    const records = await this.repo.listRecordsByBatch(workspaceId, id, { cursorRow: Number.isFinite(cursorRow) ? cursorRow : undefined, limit, status: opts.status });
    const items = records.map((r) => ({
      id: r.id, row_number: r.rowNumber, email: this.safeDecrypt(r.emailCiphertext), domain: r.domainNormalized,
      status: r.status, mode: r.mode, confidence: r.confidence, reason_codes: r.reasonCodes, checks: r.checksPerformed, checked_at: r.checkedAt,
    }));
    const nextCursor = records.length === limit && records.length > 0 ? Buffer.from(String(records[records.length - 1].rowNumber ?? "")).toString("base64url") : null;
    return { batch_id: id, items, next_cursor: nextCursor };
  }

  async cancel(workspaceId: string, id: string) {
    const batch = await this.repo.findBatchById(workspaceId, id);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    if (["completed", "completed_with_errors", "cancelled", "failed", "expired"].includes(batch.status)) {
      throw new ApiError("BATCH_NOT_CANCELLABLE", `Batch in status ${batch.status} cannot be cancelled.`, 409);
    }
    // Release any unused reservation (idempotent key).
    await this.credits.release(workspaceId, batch.creditsReserved, id, `release:cancel:batch:${id}`, "Release reservation on cancel");
    const updated = await this.repo.updateBatch(workspaceId, id, { status: "cancelled", completedAt: new Date() });
    return this.present(updated!);
  }

  async exportCsv(workspaceId: string, id: string) {
    const batch = await this.repo.findBatchById(workspaceId, id);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    const rows = await this.repo.listBatchRows(id);
    const records = await this.repo.listAllRecordsByBatch(workspaceId, id);
    const byRow = new Map(records.map((r) => [r.rowNumber, r]));
    const byId = new Map(records.map((r) => [r.id, r]));
    const lines = ["row_number,email,status,confidence,reason_codes"];
    for (const row of rows) {
      let rec = byRow.get(row.rowNumber);
      if (row.isDuplicate) {
        const canonicalRow = rows.find((r) => r.rowNumber === row.duplicateOfRowNumber);
        rec = canonicalRow ? byRow.get(canonicalRow.rowNumber) : undefined;
        lines.push([row.rowNumber, escapeCsvCell(row.originalEmail ?? ""), "duplicate", "", rec ? "duplicate_of_row_" + row.duplicateOfRowNumber : ""].join(","));
        continue;
      }
      void byId;
      lines.push([row.rowNumber, escapeCsvCell(rec ? this.safeDecrypt(rec.emailCiphertext) : row.originalEmail ?? ""), rec?.status ?? "", rec?.confidence ?? "", escapeCsvCell((rec?.reasonCodes ?? []).join(";"))].join(","));
    }
    return lines.join("\n") + "\n";
  }

  async deleteBatch(workspaceId: string, id: string, actorId?: string) {
    const batch = await this.repo.findBatchById(workspaceId, id);
    if (!batch) throw new ApiError("NOT_FOUND", "Batch not found.", 404);
    // Verified purge: records + rows removed with the batch, ledger links
    // severed, audit event written (RetentionService.purgeBatch semantics).
    const { RetentionService } = await import("../retention/retention.service");
    const res = await new RetentionService(this.repo).purgeBatch(workspaceId, id, actorId ?? null);
    return { deleted: res.deleted, id, records_removed: res.recordsRemoved };
  }

  private safeDecrypt(ciphertext: string) { try { return decryptValue(ciphertext, this.config.ENCRYPTION_KEY); } catch { return ""; } }
  present(b: any) {
    return {
      id: b.id, name: b.name ?? null, status: b.status, mode: b.mode, source_type: b.sourceType,
      row_count: b.rowCount, unique_count: b.uniqueCount, duplicate_count: b.duplicateCount,
      completed_count: b.completedCount, invalid_count: b.invalidCount, risky_count: b.riskyCount, unknown_count: b.unknownCount,
      credits_reserved: b.creditsReserved, credits_charged: b.creditsCharged, credits_refunded: b.creditsRefunded,
      created_at: b.createdAt, updated_at: b.updatedAt, started_at: b.startedAt, completed_at: b.completedAt, expires_at: b.expiresAt,
    };
  }
}
