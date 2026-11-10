/**
 * Local API result shape. Verification itself is delegated to
 * @mailcheckr/core's verifyQuick with types from @mailcheckr/contracts
 * (see verification.service.ts); this interface is the API layer's internal
 * shape (adds `billable` per PRD §9 and disposable/role check detail).
 */
export const VERIFICATION_STATUSES = ["valid", "likely_valid", "invalid", "risky", "unknown"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type Confidence = "high" | "medium" | "low";
export type VerificationMode = "quick" | "deep";

export const REASON_CODES = [
  "syntax_invalid", "domain_nxdomain", "dns_temporary_failure", "null_mx",
  "mx_missing_implicit_route_checked", "mx_host_unresolved", "disposable_domain",
  "role_account", "free_provider", "smtp_not_attempted_quick_mode",
  "smtp_port_unavailable", "smtp_starttls_unavailable", "smtp_tls_handshake_failed",
  "smtp_connection_timeout", "smtp_connection_refused", "smtp_greylisted",
  "smtp_rate_limited", "smtp_policy_rejected", "smtp_mailbox_accepted",
  "smtp_mailbox_rejected_definitive", "catch_all_suspected", "catch_all_unchecked",
  "provider_defers_recipient_validation", "internationalized_local_part_unsupported",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ChecksPerformed {
  syntax: "passed" | "failed" | "not_checked" | "inconclusive";
  domain: "passed" | "failed" | "not_checked" | "inconclusive";
  mx: "passed" | "failed" | "not_checked" | "inconclusive";
  smtp_mailbox: "passed" | "failed" | "not_checked" | "inconclusive";
  disposable: "passed" | "failed" | "not_checked";
  role_account: "passed" | "flagged" | "not_checked";
}

export interface VerificationResult {
  status: VerificationStatus;
  mode: VerificationMode;
  confidence: Confidence;
  email: string; // normalized address (domain lowercased / punycode)
  originalEmail: string;
  domain: string;
  reasonCodes: ReasonCode[];
  checks: ChecksPerformed;
  explanation: string;
  dnsEvidence: Record<string, unknown>;
  smtpEvidence: Record<string, unknown>;
  checkedAt: string; // ISO timestamp
  billable: boolean; // false for unknown and duplicates (PRD §9)
}
