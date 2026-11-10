/** Repository interface — implemented by InMemoryRepository (tests/dev without
 * Postgres) and PrismaRepository (production). Every tenant query is scoped by
 * workspaceId taken from the auth context, never from client input (PRD §7/§10). */
export interface UserRow { id: string; email: string; passwordHash: string | null; emailVerifiedAt: Date | null; createdAt: Date; deletedAt: Date | null; }
export interface WorkspaceRow { id: string; ownerUserId: string; name: string; planCode: string; createdAt: Date; }
export interface ApiKeyRow { id: string; workspaceId: string; name: string; keyPrefix: string; keyHash: string; scopes: string[]; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date; }
export type BatchStatus = "created"|"queued"|"processing"|"completed"|"completed_with_errors"|"failed"|"cancelled"|"expired";
export interface BatchRowData { id: string; workspaceId: string; createdByUserId: string | null; name: string | null; sourceType: "upload"|"paste"|"api"; originalFilename: string | null; emailColumnName: string | null; mode: "quick"|"deep"; status: BatchStatus; rowCount: number; uniqueCount: number; duplicateCount: number; completedCount: number; invalidCount: number; riskyCount: number; unknownCount: number; creditsReserved: number; creditsCharged: number; creditsRefunded: number; idempotencyKey: string | null; startedAt: Date | null; completedAt: Date | null; expiresAt: Date | null; createdAt: Date; updatedAt: Date; }
export interface RecordRow { id: string; workspaceId: string; batchId: string | null; emailCiphertext: string; emailHmac: string; domainNormalized: string; rowNumber: number | null; status: string; mode: string; confidence: string; reasonCodes: string[]; checksPerformed: Record<string, unknown>; dnsEvidence: Record<string, unknown> | null; smtpEvidence: Record<string, unknown> | null; idempotencyKey: string | null; checkedAt: Date; expiresAt: Date | null; createdAt: Date; }
export interface BatchRowRow { id: string; batchId: string; rowNumber: number; emailRecordId: string | null; isDuplicate: boolean; duplicateOfRowNumber: number | null; parseErrorCode: string | null; originalEmail: string | null; }
export type CreditEntryType = "grant"|"reserve"|"charge"|"release"|"refund"|"purchase"|"adjustment";
export interface LedgerRow { id: string; workspaceId: string; batchId: string | null; verificationRecordId: string | null; entryType: CreditEntryType; quantity: number; idempotencyKey: string; description: string | null; createdAt: Date; }
export interface ResetTokenRow { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date; }
export interface AuditRow { id: string; workspaceId: string | null; actorId: string | null; action: string; resourceType: string; resourceId: string | null; metadata: Record<string, unknown> | null; createdAt: Date; }

export interface Repository {
  // users / workspaces
  createUser(data: Omit<UserRow, "id"|"createdAt"|"deletedAt"|"emailVerifiedAt"> & { emailVerifiedAt?: Date | null }): Promise<UserRow>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  createWorkspace(data: { ownerUserId: string; name: string; planCode?: string }): Promise<WorkspaceRow>;
  findWorkspaceById(id: string): Promise<WorkspaceRow | null>;
  findWorkspaceByOwner(userId: string): Promise<WorkspaceRow | null>;
  // password reset
  createResetToken(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<ResetTokenRow>;
  findResetTokenByHash(tokenHash: string): Promise<ResetTokenRow | null>;
  markResetTokenUsed(id: string): Promise<void>;
  // api keys
  createApiKey(data: Omit<ApiKeyRow, "id"|"createdAt"|"lastUsedAt"|"revokedAt"> & { lastUsedAt?: Date | null; revokedAt?: Date | null }): Promise<ApiKeyRow>;
  listApiKeys(workspaceId: string): Promise<ApiKeyRow[]>;
  findApiKeysByPrefix(prefix: string): Promise<ApiKeyRow[]>;
  findApiKeyById(workspaceId: string, id: string): Promise<ApiKeyRow | null>;
  revokeApiKey(workspaceId: string, id: string): Promise<ApiKeyRow | null>;
  touchApiKey(id: string): Promise<void>;
  // batches / records / rows
  createBatch(data: Omit<BatchRowData, "id"|"createdAt"|"updatedAt">): Promise<BatchRowData>;
  listBatches(workspaceId: string, opts: { limit: number; offset?: number }): Promise<BatchRowData[]>;
  findBatchById(workspaceId: string, id: string): Promise<BatchRowData | null>;
  findBatchByIdempotencyKey(workspaceId: string, key: string): Promise<BatchRowData | null>;
  updateBatch(workspaceId: string, id: string, patch: Partial<BatchRowData>): Promise<BatchRowData | null>;
  deleteBatch(workspaceId: string, id: string): Promise<boolean>;
  createRecord(data: Omit<RecordRow, "id"|"createdAt">): Promise<RecordRow>;
  findRecordByIdempotencyKey(workspaceId: string, key: string): Promise<RecordRow | null>;
  listRecordsByBatch(workspaceId: string, batchId: string, opts: { cursorRow?: number; limit: number; status?: string }): Promise<RecordRow[]>;
  listAllRecordsByBatch(workspaceId: string, batchId: string): Promise<RecordRow[]>;
  /** Recent verification records for a workspace, newest first. With
   *  `singleOnly`, only single checks (batch_id IS NULL) are returned. */
  listRecentRecords(workspaceId: string, opts: { limit: number; singleOnly?: boolean }): Promise<RecordRow[]>;
  countRecords(workspaceId: string): Promise<number>;
  countRecordsSince(workspaceId: string, since: Date): Promise<number>;
  createBatchRow(data: Omit<BatchRowRow, "id">): Promise<BatchRowRow>;
  listBatchRows(batchId: string): Promise<BatchRowRow[]>;
  deleteRecordsByBatch(workspaceId: string, batchId: string): Promise<void>;
  // ledger
  createLedgerEntry(data: Omit<LedgerRow, "id"|"createdAt">): Promise<LedgerRow>;
  findLedgerByIdempotencyKey(key: string): Promise<LedgerRow | null>;
  listLedger(workspaceId: string, opts: { limit: number; offset: number }): Promise<LedgerRow[]>;
  sumLedger(workspaceId: string): Promise<number>;
  listExpiredBatches(now: Date): Promise<BatchRowData[]>;
  /** On verified deletion: ledger rows are financial records and are kept for
   * accounting, but their links to the purged batch/record (personal-data
   * references) are severed. */
  anonymizeLedgerForBatch(batchId: string): Promise<void>;
  // audit
  createAudit(data: Omit<AuditRow, "id"|"createdAt">): Promise<AuditRow>;
  /** Verified account purge (DELETE /v1/account): removes every batch,
   *  record, batch row and API key of the workspace, severs the credit
   *  ledger's links to batches/records while KEEPING the entries and their
   *  amounts as the accounting record, then deletes the workspace and the
   *  user. Audit events are kept (their workspace link is severed). */
  purgeWorkspace(workspaceId: string, ownerUserId: string): Promise<{ batchesRemoved: number; recordsRemoved: number; apiKeysRemoved: number; ledgerEntriesRetained: number }>;
}

export const REPOSITORY = "REPOSITORY";
export const APP_CONFIG = "APP_CONFIG";
