import { Body, Controller, Get, Inject, Post, Query, Req } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { APP_CONFIG, REPOSITORY, type Repository } from "../repositories/repository";
import { RATE_LIMITER, RateLimiter } from "../common/rate-limit";
import { CreditLedgerService } from "../credits/credit-ledger.service";
import { decryptValue, encryptValue, hmacDigest } from "../common/crypto";
import { VerificationService } from "./verification.service";
import type { AuthContext } from "../auth/auth.guard";

@Controller("v1/verifications")
export class VerificationsController {
  private credits: CreditLedgerService;
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(APP_CONFIG) private readonly config: any,
    @Inject(VerificationService) private readonly verifier: VerificationService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) { this.credits = new CreditLedgerService(repo); }

  /** Recent single checks for the caller's workspace (batch_id IS NULL),
   *  newest first — backs the dashboard's "Recent checks" table. Records are
   *  the rows persisted by POST /v1/verifications below. */
  @Get()
  async list(@Req() req: any, @Query("limit") limit?: string) {
    const a = req.auth as AuthContext;
    const take = Math.min(Math.max(Number(limit ?? 10) || 10, 1), 200);
    const rows = await this.repo.listRecentRecords(a.workspaceId, { limit: take, singleOnly: true });
    return { data: rows.map((r) => this.present(r)) };
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const a = req.auth as AuthContext;
    const rate = this.limiter.check(`ws:${a.workspaceId}:${a.apiKeyId ?? a.userId ?? "session"}`);
    if (!rate.allowed) throw new ApiError("RATE_LIMITED", "Request rate limit exceeded.", 429, rate.retryAfterSeconds);
    const email = body?.email;
    const mode: "quick" | "deep" = body?.mode === "deep" ? "deep" : "quick";
    if (!email || typeof email !== "string") throw new ApiError("VALIDATION_ERROR", "email is required.", 422);
    if (body?.idempotency_key) {
      const existing = await this.repo.findRecordByIdempotencyKey(a.workspaceId, `single:${body.idempotency_key}`);
      if (existing) return this.present(existing);
    }
    const balance = await this.credits.balance(a.workspaceId);
    if (balance < 1) throw new ApiError("INSUFFICIENT_CREDITS", "Insufficient credits for a verification.", 402);
    const deepEnabled = this.config.SMTP_DEEP_ENABLED === true && this.config.SMTP_EGRESS_APPROVED === true;
    const result = await this.verifier.verify(email, mode, { deepEnabled });
    const record = await this.repo.createRecord({
      workspaceId: a.workspaceId, batchId: null,
      emailCiphertext: encryptValue(result.email, this.config.ENCRYPTION_KEY),
      emailHmac: hmacDigest(result.email, this.config.HMAC_KEY),
      domainNormalized: result.domain, rowNumber: null, status: result.status, mode: result.mode,
      confidence: result.confidence, reasonCodes: result.reasonCodes, checksPerformed: result.checks as unknown as Record<string, unknown>,
      dnsEvidence: result.dnsEvidence, smtpEvidence: result.smtpEvidence,
      idempotencyKey: body?.idempotency_key ? `single:${body.idempotency_key}` : null,
      checkedAt: new Date(result.checkedAt),
      expiresAt: new Date(Date.now() + (this.config.RESULT_RETENTION_DAYS ?? 7) * 86400_000),
    });
    // Unknown results are not charged (enforced inside the ledger service too).
    if (result.billable) {
      await this.credits.chargeForVerification({ workspaceId: a.workspaceId, recordId: record.id, status: result.status, idempotencyKey: `charge:record:${record.id}` });
    }
    return this.present(record, result.explanation);
  }

  private present(r: any, explanation?: string) {
    let email = "";
    try { email = decryptValue(r.emailCiphertext, this.config.ENCRYPTION_KEY); } catch { email = ""; }
    return {
      id: r.id, status: r.status, mode: r.mode, confidence: r.confidence, email, domain: r.domainNormalized,
      checks: r.checksPerformed, reason_codes: r.reasonCodes,
      explanation: explanation ?? defaultExplanation(r.status, r.reasonCodes),
      checked_at: r.checkedAt, created_at: r.createdAt,
    };
  }
}
export function defaultExplanation(status: string, reasonCodes: string[]): string {
  if (reasonCodes.includes("smtp_port_unavailable")) return "Deep SMTP verification is unavailable in this environment (outbound port 25 not approved/tested); the individual mailbox was not tested.";
  if (status === "likely_valid") return "The address format and domain mail routing appear valid. The individual mailbox was not tested in Quick mode.";
  if (status === "invalid") return "The address is invalid based on the checks performed.";
  if (status === "risky") return "The address has a documented risk signal; see reason_codes.";
  if (status === "unknown") return "The address could not be determined from the available evidence.";
  return "The mail server accepted the recipient at the SMTP RCPT stage at check time; this is not a guarantee of inbox delivery.";
}
