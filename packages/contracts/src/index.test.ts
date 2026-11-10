import { describe, it, expect } from "vitest";
import {
  REASON_CODES,
  VERIFICATION_STATUSES,
  verificationResultSchema,
  singleVerificationRequestSchema,
  batchCreateRequestSchema,
  apiErrorEnvelopeSchema,
} from "./index";

describe("contracts enums (PRD §4)", () => {
  it("has exactly the five canonical mailbox statuses, no duplicate", () => {
    expect([...VERIFICATION_STATUSES]).toEqual(["valid", "likely_valid", "invalid", "risky", "unknown"]);
  });
  it("implements every PRD §4.3 reason code plus catch_all_unchecked", () => {
    const prd = [
      "syntax_invalid","domain_nxdomain","dns_temporary_failure","null_mx",
      "mx_missing_implicit_route_checked","mx_host_unresolved","disposable_domain",
      "role_account","free_provider","smtp_not_attempted_quick_mode","smtp_port_unavailable",
      "smtp_starttls_unavailable","smtp_tls_handshake_failed","smtp_connection_timeout",
      "smtp_connection_refused","smtp_greylisted","smtp_rate_limited","smtp_policy_rejected",
      "smtp_mailbox_accepted","smtp_mailbox_rejected_definitive","catch_all_suspected",
      "provider_defers_recipient_validation","internationalized_local_part_unsupported",
      "catch_all_unchecked",
    ];
    expect([...REASON_CODES].sort()).toEqual([...prd].sort());
  });
  it("has no numeric score field on the result schema", () => {
    expect(Object.keys(verificationResultSchema.shape)).not.toContain("score");
  });
});

describe("contracts schemas", () => {
  const result = {
    status: "likely_valid" as const,
    mode: "quick" as const,
    confidence: "medium" as const,
    email: "person@example.com",
    domain: "example.com",
    checks: { syntax: "passed" as const, domain: "passed" as const, mx: "passed" as const, smtp_mailbox: "not_checked" as const },
    checks_performed: ["syntax", "dns_mx"],
    reason_codes: ["smtp_not_attempted_quick_mode" as const],
    explanation: "Format and routing appear valid; mailbox not tested in Quick mode.",
    observed_at: "2026-11-10T00:00:00.000Z",
  };
  it("accepts a well-formed quick result", () => {
    expect(verificationResultSchema.safeParse(result).success).toBe(true);
  });
  it("rejects an unknown reason code and a bogus status", () => {
    expect(verificationResultSchema.safeParse({ ...result, reason_codes: ["made_up"] }).success).toBe(false);
    expect(verificationResultSchema.safeParse({ ...result, status: "duplicate" }).success).toBe(false);
  });
  it("defaults single verification mode to quick and caps batch at 1000", () => {
    expect(singleVerificationRequestSchema.parse({ email: "a@b.co" }).mode).toBe("quick");
    expect(batchCreateRequestSchema.safeParse({ name: "x", emails: Array(1001).fill("a@b.co") }).success).toBe(false);
  });
  it("validates the §8.6 error envelope", () => {
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: "RATE_LIMITED", message: "slow down", request_id: "req_1", retry_after_seconds: 30 } }).success).toBe(true);
  });
});
