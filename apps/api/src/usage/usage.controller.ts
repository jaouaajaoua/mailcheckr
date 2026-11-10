import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { REPOSITORY, type Repository } from "../repositories/repository";
import { CreditLedgerService } from "../credits/credit-ledger.service";
import type { AuthContext } from "../auth/auth.guard";

@Controller("v1")
export class UsageController {
  private credits: CreditLedgerService;
  constructor(@Inject(REPOSITORY) private readonly repo: Repository) { this.credits = new CreditLedgerService(repo); }

  @Get("usage")
  async usage(@Req() req: any) {
    const a = req.auth as AuthContext;
    const entries = await this.repo.listLedger(a.workspaceId, { limit: 100000, offset: 0 });
    const sum = (t: string) => entries.filter((e) => e.entryType === t).reduce((s, e) => s + e.quantity, 0);
    const workspace = await this.repo.findWorkspaceById(a.workspaceId);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    // Outstanding reservation = reservations not yet released (positive).
    const creditsReserved = Math.max(0, -(sum("reserve") + sum("release")));
    const checksTotal = await this.repo.countRecords(a.workspaceId);
    return {
      workspace_id: a.workspaceId,
      plan_code: workspace?.planCode ?? "free",
      credits_balance: await this.credits.balance(a.workspaceId),
      credits_granted: sum("grant") + sum("purchase"),
      credits_charged: -sum("charge"),
      credits_reserved: creditsReserved,
      credits_reserved_outstanding: creditsReserved,
      checks_total: checksTotal,
      checks_this_month: await this.repo.countRecordsSince(a.workspaceId, periodStart),
      verifications_total: checksTotal,
      period_start: periodStart,
      period_end: periodEnd,
    };
  }
  @Get("credits/ledger")
  async ledger(@Req() req: any, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const a = req.auth as AuthContext;
    const rows = await this.credits.list(a.workspaceId, Math.min(Number(limit ?? 50) || 50, 200), Number(offset ?? 0) || 0);
    return { items: rows.map((e) => ({ id: e.id, entry_type: e.entryType, quantity: e.quantity, batch_id: e.batchId, verification_record_id: e.verificationRecordId, description: e.description, created_at: e.createdAt })), balance: await this.credits.balance(a.workspaceId) };
  }
}
