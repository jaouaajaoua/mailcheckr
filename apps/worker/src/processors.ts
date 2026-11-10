import { Readable } from "node:stream";
import { parse } from "csv-parse";
import type { WorkerRepository } from "./repositories";
import { chargeForResult, ledgerApply } from "./credits";
import { verifyQuick, type DnsResolver } from "./verify";
import { withRetry } from "./retry";
import { DomainThrottle } from "./throttle";

export const MAX_CSV_ROWS = 10_000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB upload cap (PRD §8.3/§10.4)

/** Detect the email column: exact header match first, then any header containing "email". */
export function detectEmailColumn(headers: string[], explicit?: string): string | null {
  if (explicit && headers.includes(explicit)) return explicit;
  const exact = headers.find((h) => h.trim().toLowerCase() === "email");
  if (exact) return exact;
  return headers.find((h) => h.toLowerCase().includes("email")) ?? null;
}

export interface ParsedCsv { headers: string[]; emailColumn: string; rows: { rowNumber: number; original: Record<string, string>; email: string; parseErrorCode: string | null }[]; }

/** Streaming CSV parse (csv-parse over a Readable — the file is never loaded
 * as a single string by callers in production; the source object stream is
 * piped in). Enforces the 10,000-row dashboard cap (PRD §8.3/§11). */
export async function parseCsvStream(source: NodeJS.ReadableStream, opts: { emailColumn?: string; maxRows?: number; maxBytes?: number } = {}): Promise<ParsedCsv> {
  const maxRows = opts.maxRows ?? MAX_CSV_ROWS;
  const maxBytes = opts.maxBytes ?? MAX_CSV_BYTES;
  let bytes = 0;
  const meter = new (require("node:stream").Transform)({
    transform(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new Error(`PAYLOAD_TOO_LARGE: CSV exceeds ${maxBytes} bytes`));
      else { this.push(chunk); cb(); }
    },
  });
  const parser = parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  // pipeline() propagates errors (incl. the byte-cap meter) and destroys all
  // streams, so a mid-stream failure can neither hang nor go unhandled.
  let streamError: Error | null = null;
  const { pipeline } = require("node:stream");
  pipeline(source, meter, parser, (e: unknown) => { if (e && !streamError) streamError = e instanceof Error ? e : new Error(String(e)); });
  const rows: ParsedCsv["rows"] = [];
  let headers: string[] = []; let emailColumn: string | null = null; let n = 0;
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    if (n === 0) { headers = Object.keys(record); emailColumn = detectEmailColumn(headers, opts.emailColumn); if (!emailColumn) throw new Error("EMAIL_COLUMN_NOT_FOUND: no email column detected; specify emailColumn explicitly"); }
    n++;
    if (n > maxRows) throw new Error(`CSV_TOO_LARGE: exceeds ${maxRows} rows`);
    const email = (record[emailColumn!] ?? "").trim();
    rows.push({ rowNumber: n, original: record, email, parseErrorCode: email ? null : "missing_email_value" });
  }
  if (streamError) throw streamError;
  if (n === 0) throw new Error("CSV_EMPTY: no data rows found");
  return { headers, emailColumn: emailColumn!, rows };
}
export function parseCsvText(text: string, opts: { emailColumn?: string; maxRows?: number; maxBytes?: number } = {}) {
  return parseCsvStream(Readable.from([text]), opts);
}

/** bulk-parse processor: create batch + rows from a parsed CSV, dedupe by
 * normalized address, reserve credits for unique rows only. Idempotent per
 * batch idempotency key handled by the caller/queue job id. */
export async function bulkParseProcessor(repo: WorkerRepository, input: { workspaceId: string; parsed: ParsedCsv; mode: "quick" | "deep"; retentionDays?: number }) {
  const seen = new Map<string, number>();
  let unique = 0, duplicates = 0;
  const batch = await repo.createBatch({
    workspaceId: input.workspaceId, mode: input.mode, status: "queued",
    rowCount: input.parsed.rows.length, uniqueCount: 0, duplicateCount: 0, completedCount: 0,
    invalidCount: 0, riskyCount: 0, unknownCount: 0, creditsReserved: 0, creditsCharged: 0, creditsRefunded: 0,
    emailColumnName: input.parsed.emailColumn, originalColumns: input.parsed.headers,
    startedAt: null, completedAt: null, expiresAt: new Date(Date.now() + (input.retentionDays ?? 7) * 86400_000),
  });
  for (const row of input.parsed.rows) {
    const at = row.email.lastIndexOf("@");
    const key = at > 0 ? `${row.email.slice(0, at)}@${row.email.slice(at + 1).toLowerCase()}` : row.email.toLowerCase();
    const isDuplicate = !!key && seen.has(key);
    if (isDuplicate) duplicates++; else if (key) { seen.set(key, row.rowNumber); unique++; }
    await repo.addRow({ batchId: batch.id, rowNumber: row.rowNumber, original: row.original, email: row.email, isDuplicate, duplicateOfRowNumber: isDuplicate ? seen.get(key)! : null, emailRecordId: null, parseErrorCode: row.parseErrorCode });
  }
  await ledgerApply(repo, { workspaceId: input.workspaceId, entryType: "reserve", quantity: -unique, idempotencyKey: `reserve:batch:${batch.id}`, batchId: batch.id });
  const updated = await repo.updateBatch(input.workspaceId, batch.id, { uniqueCount: unique, duplicateCount: duplicates, creditsReserved: unique });
  return updated!;
}

/** verify processor: verifies unique rows, persists records, settles credits.
 * Idempotent: completed batches are a no-op; already-recorded rows are
 * skipped; per-record charge idempotency keys prevent double charging after
 * a worker crash/restart (PRD §11/§13.2). */
export async function verifyBatchProcessor(repo: WorkerRepository, dns: DnsResolver, input: { workspaceId: string; batchId: string; deepEnabled?: boolean; throttle?: DomainThrottle; sleep?: (ms: number) => Promise<void> }) {
  const throttle = input.throttle ?? new DomainThrottle(Number(process.env.MAX_CONCURRENT_PER_DOMAIN ?? 2), Number(process.env.DOMAIN_COOLDOWN_MS ?? 60_000));
  const batch = await repo.getBatch(input.workspaceId, input.batchId);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  if (["completed", "completed_with_errors", "cancelled", "expired"].includes(batch.status)) return batch;
  await repo.updateBatch(input.workspaceId, batch.id, { status: "processing", startedAt: batch.startedAt ?? new Date() });
  const rows = await repo.listRows(batch.id);
  const existing = await repo.listRecords(input.workspaceId, batch.id);
  const done = new Set(existing.map((r) => r.rowNumber));
  let invalid = existing.filter((r) => r.status === "invalid").length;
  let risky = existing.filter((r) => r.status === "risky").length;
  let unknown = existing.filter((r) => r.status === "unknown").length;
  let charged = existing.filter((r) => r.status !== "unknown").length;
  let completed = existing.length;
  for (const row of rows) {
    if (row.isDuplicate || row.parseErrorCode || done.has(row.rowNumber)) continue;
    const atIdx = row.email.lastIndexOf("@");
    const rowDomain = atIdx > 0 ? row.email.slice(atIdx + 1).toLowerCase() : "";
    // Per-domain throttling + bounded retry budget (max 3 attempts) for thrown
    // resolver errors. A temporary DNS *result* maps to unknown and is not retried.
    let result = await throttle.run(rowDomain, () => withRetry(() => verifyQuick(row.email, dns), { maxAttempts: 3, baseDelayMs: 50, sleep: input.sleep ?? (async () => {}) }));
    if (batch.mode === "deep" && !input.deepEnabled) {
      // Deep gate off (PRD §6): cap at likely_valid, annotate, never claim valid.
      result = { ...result, status: result.status === "invalid" || result.status === "risky" ? result.status : "likely_valid", confidence: result.status === "likely_valid" ? "low" : result.confidence, reasonCodes: [...result.reasonCodes, "smtp_port_unavailable"] };
    }
    const record = await repo.addRecord({ workspaceId: input.workspaceId, batchId: batch.id, rowNumber: row.rowNumber, email: result.email, domain: result.domain, status: result.status, confidence: result.confidence, reasonCodes: result.reasonCodes });
    row.emailRecordId = record.id;
    if (result.billable) { const c = await chargeForResult(repo, { workspaceId: input.workspaceId, batchId: batch.id, recordId: record.id, status: result.status }); if (c) charged++; }
    if (result.status === "invalid") invalid++; else if (result.status === "risky") risky++; else if (result.status === "unknown") unknown++;
    completed++;
  }
  await ledgerApply(repo, { workspaceId: input.workspaceId, entryType: "release", quantity: batch.creditsReserved, idempotencyKey: `release:batch:${batch.id}`, batchId: batch.id });
  return (await repo.updateBatch(input.workspaceId, batch.id, { status: "completed", completedCount: completed, invalidCount: invalid, riskyCount: risky, unknownCount: unknown, creditsCharged: charged, completedAt: new Date() }))!;
}

/** CSV formula-injection escaping (PRD §10.4). */
export function escapeCsvCell(value: string): string {
  let v = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** export processor: preserves every original column and the original row
 * order (PRD §3.1/§13.3), appends result columns, marks duplicates. */
export async function exportBatchProcessor(repo: WorkerRepository, input: { workspaceId: string; batchId: string }): Promise<string> {
  const batch = await repo.getBatch(input.workspaceId, input.batchId);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  const rows = await repo.listRows(batch.id);
  const records = await repo.listRecords(input.workspaceId, batch.id);
  const byRow = new Map(records.map((r) => [r.rowNumber, r]));
  const headers = [...batch.originalColumns, "mailcheckr_status", "mailcheckr_confidence", "mailcheckr_reason_codes"];
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    const cells = batch.originalColumns.map((c) => escapeCsvCell(row.original[c] ?? ""));
    if (row.isDuplicate) { cells.push("duplicate", "", `duplicate_of_row_${row.duplicateOfRowNumber}`); }
    else {
      const rec = byRow.get(row.rowNumber);
      cells.push(rec?.status ?? (row.parseErrorCode ? "unknown" : ""), rec?.confidence ?? "", escapeCsvCell((rec?.reasonCodes ?? [row.parseErrorCode ?? ""]).join(";")));
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

/** Dead-letter handling (PRD §11): after BullMQ exhausts the retry budget
 * (attempts: 3, exponential backoff — see queues.ts), the batch is moved to a
 * terminal `failed` state instead of looping forever. Idempotent. */
export async function markBatchDeadLetter(repo: WorkerRepository, input: { workspaceId: string; batchId: string; error: string }) {
  const batch = await repo.getBatch(input.workspaceId, input.batchId);
  if (!batch) return null;
  if (["completed", "completed_with_errors", "cancelled", "expired", "failed"].includes(batch.status)) return batch;
  return repo.updateBatch(input.workspaceId, batch.id, { status: "failed", completedAt: new Date() });
}

/** scheduler processor: expire batches past their retention window and delete
 * their result records (PRD §10.2). Idempotent — expired batches are skipped
 * on re-run. */
export async function expireBatchesProcessor(repo: WorkerRepository, now = new Date()) {
  const expired = await repo.listExpiredBatches(now);
  let count = 0;
  for (const batch of expired) {
    await repo.deleteRecords(batch.workspaceId, batch.id);
    await repo.updateBatch(batch.workspaceId, batch.id, { status: "expired" });
    count++;
  }
  return { expired: count };
}
