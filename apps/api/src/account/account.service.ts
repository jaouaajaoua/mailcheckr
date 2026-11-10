import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { APP_CONFIG, REPOSITORY, type Repository } from "../repositories/repository";
import { CreditLedgerService } from "../credits/credit-ledger.service";

/**
 * Workspace account settings + verified account deletion (PRD §10.2).
 *
 * Deletion is a real purge, not a "request" stub: every batch, verification
 * record, batch row and API key of the workspace is removed; the credit
 * ledger's links to batches/records are severed while the entries and
 * amounts are retained as the accounting record; then the workspace and
 * the user are deleted. An audit event is written BEFORE the purge (its
 * workspace link is severed by the purge, the event itself is retained).
 */
@Injectable()
export class AccountService {
  private credits: CreditLedgerService;
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(APP_CONFIG) private readonly config: any,
  ) { this.credits = new CreditLedgerService(repo); }

  async getSettings(workspaceId: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) throw new ApiError("NOT_FOUND", "Workspace not found.", 404);
    const entries = await this.repo.listLedger(workspaceId, { limit: 100000, offset: 0 });
    const sum = (t: string) => entries.filter((e) => e.entryType === t).reduce((s, e) => s + e.quantity, 0);
    const resultRetentionDays = this.config.RESULT_RETENTION_DAYS ?? 7;
    const sourceRetentionHours = this.config.SOURCE_RETENTION_HOURS ?? 24;
    return {
      workspace_id: workspaceId,
      plan_code: workspace.planCode,
      // Retention actually in force (consumed by BatchesService expiry and
      // the retention scheduler) — read back live, never hardcoded in the UI.
      source_retention_hours: sourceRetentionHours,
      source_retention_days: sourceRetentionHours / 24,
      result_retention_days: resultRetentionDays,
      retention_days: resultRetentionDays,
      credits_balance: await this.credits.balance(workspaceId),
      credits_granted: sum("grant") + sum("purchase"),
      credits_charged: -sum("charge"),
      credits_reserved: Math.max(0, -(sum("reserve") + sum("release"))),
      checks_total: await this.repo.countRecords(workspaceId),
    };
  }

  async deleteAccount(input: { workspaceId: string; userId: string | null; via: string }) {
    // Account deletion is a user-session action: an API key must not be able
    // to destroy the account it belongs to.
    if (input.via !== "jwt" || !input.userId) {
      throw new ApiError("FORBIDDEN", "Account deletion requires a signed-in user session.", 403);
    }
    const workspace = await this.repo.findWorkspaceById(input.workspaceId);
    if (!workspace) throw new ApiError("NOT_FOUND", "Workspace not found.", 404);
    if (workspace.ownerUserId !== input.userId) {
      throw new ApiError("FORBIDDEN", "Only the workspace owner can delete this account.", 403);
    }
    await this.repo.createAudit({
      workspaceId: input.workspaceId, actorId: input.userId, action: "account.delete",
      resourceType: "user", resourceId: input.userId,
      metadata: { self_service: true, confirmation: "DELETE" },
    });
    const counts = await this.repo.purgeWorkspace(input.workspaceId, input.userId);
    return {
      status: "deleted",
      deleted: true,
      workspace_id: input.workspaceId,
      batches_removed: counts.batchesRemoved,
      records_removed: counts.recordsRemoved,
      api_keys_removed: counts.apiKeysRemoved,
      ledger_entries_retained: counts.ledgerEntriesRetained,
    };
  }
}
