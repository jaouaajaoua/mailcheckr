import { verifyQuick as coreVerifyQuick, type DnsResolver } from "@mailcheckr/core";
import type { VerificationResultDto } from "@mailcheckr/contracts";
import type { ReasonCode, VerificationResult } from "./local-contracts";

/**
 * API verification service — a thin adapter over @mailcheckr/core's
 * verifyQuick (parsing, risk datasets, DNS routing, conservative Quick
 * classification) plus the Deep-mode release gate (PRD §6):
 *
 * - mode=deep with the gate OFF never claims mailbox verification: the
 *   result is the Quick classification capped at likely_valid (definitive
 *   invalid/risky evidence is kept), with reason `smtp_port_unavailable`
 *   and an explicit explanation.
 * - mode=deep with the gate ON still makes no synchronous `valid` claim
 *   here — RCPT probing belongs to the isolated SMTP worker (PRD §5.4).
 * - This service never opens an SMTP connection and never sends email.
 */
export class VerificationService {
  constructor(private readonly dnsResolver: DnsResolver) {}

  private adapt(dto: VerificationResultDto, originalEmail: string): VerificationResult {
    const reasonCodes = dto.reason_codes as ReasonCode[];
    return {
      status: dto.status,
      mode: dto.mode,
      confidence: dto.confidence,
      email: dto.normalized_email ?? dto.email,
      originalEmail,
      domain: dto.domain ?? "",
      reasonCodes,
      checks: {
        syntax: dto.checks.syntax, domain: dto.checks.domain, mx: dto.checks.mx, smtp_mailbox: dto.checks.smtp_mailbox,
        disposable: reasonCodes.includes("disposable_domain") ? "failed" : "passed",
        role_account: reasonCodes.includes("role_account") ? "flagged" : "passed",
      },
      explanation: dto.explanation,
      dnsEvidence: { checks_performed: dto.checks_performed },
      smtpEvidence: { attempted: false, reason: dto.mode === "quick" ? "quick_mode" : "not_attempted_by_api" },
      checkedAt: dto.checked_at ?? dto.observed_at,
      billable: dto.status !== "unknown", // PRD §9: unknown is never charged; duplicates never reach this service
    };
  }

  async verifyQuick(rawEmail: string): Promise<VerificationResult> {
    const dto = await coreVerifyQuick(rawEmail, { dns: this.dnsResolver });
    return this.adapt(dto, rawEmail);
  }

  async verify(rawEmail: string, mode: "quick" | "deep", opts: { deepEnabled: boolean }): Promise<VerificationResult> {
    const result = await this.verifyQuick(rawEmail);
    if (mode === "quick") return result;
    if (!opts.deepEnabled) {
      const capped = result.status === "valid" ? "likely_valid" : result.status;
      return {
        ...result, mode: "deep",
        status: capped as VerificationResult["status"],
        confidence: capped === "likely_valid" ? "low" : result.confidence,
        reasonCodes: Array.from(new Set<ReasonCode>([...result.reasonCodes, "smtp_port_unavailable"])),
        checks: { ...result.checks, smtp_mailbox: "not_checked" },
        smtpEvidence: { attempted: false, reason: "smtp_port_unavailable" },
        explanation: "Deep SMTP verification is unavailable: outbound port 25 has not been approved/tested in this environment, so the individual mailbox was not tested. " + result.explanation,
      };
    }
    return {
      ...result, mode: "deep",
      status: result.status === "valid" ? "likely_valid" : result.status,
      reasonCodes: Array.from(new Set<ReasonCode>([...result.reasonCodes, "catch_all_unchecked"])),
      smtpEvidence: { attempted: false, reason: "smtp_worker_async" },
      explanation: result.explanation + " Mailbox-level SMTP probing is performed by the isolated SMTP worker; no synchronous valid claim is made.",
    };
  }
}
