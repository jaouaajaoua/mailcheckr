import { z } from "zod";

/**
 * @mailcheckr/contracts — shared wire contracts for MailCheckr.
 *
 * Source of truth: PRD §4 (result model), §8 (REST API), §9 (credits).
 * Core produces results in exactly this shape; the API validates with
 * these schemas. Confidence is qualitative only (PRD §4.4) — there is
 * deliberately NO numeric score field anywhere in these contracts.
 */

// ---------------------------------------------------------------------------
// §4.2 Canonical statuses
// ---------------------------------------------------------------------------

/** Mailbox-level statuses. `duplicate` is NOT here: it is row-level only. */
export const VERIFICATION_STATUSES = [
  "valid",
  "likely_valid",
  "invalid",
  "risky",
  "unknown",
] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

/** Row-level disposition in a bulk import. Canonical rows carry a mailbox
 *  status; duplicate rows point at the canonical row and are not charged. */
export const ROW_DISPOSITIONS = ["canonical", "duplicate"] as const;
export const rowDispositionSchema = z.enum(ROW_DISPOSITIONS);
export type RowDisposition = z.infer<typeof rowDispositionSchema>;

// ---------------------------------------------------------------------------
// §4.3 Reason codes (all PRD codes plus `catch_all_unchecked` from §4.6)
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  "syntax_invalid",
  "domain_nxdomain",
  "dns_temporary_failure",
  "null_mx",
  "mx_missing_implicit_route_checked",
  "mx_host_unresolved",
  "disposable_domain",
  "role_account",
  "free_provider",
  "smtp_not_attempted_quick_mode",
  "smtp_port_unavailable",
  "smtp_starttls_unavailable",
  "smtp_tls_handshake_failed",
  "smtp_connection_timeout",
  "smtp_connection_refused",
  "smtp_greylisted",
  "smtp_rate_limited",
  "smtp_policy_rejected",
  "smtp_mailbox_accepted",
  "smtp_mailbox_rejected_definitive",
  "catch_all_suspected",
  "provider_defers_recipient_validation",
  "internationalized_local_part_unsupported",
  "catch_all_unchecked",
] as const;
export const reasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

// ---------------------------------------------------------------------------
// §4.4 Confidence — qualitative evidence labels only, never a probability
// ---------------------------------------------------------------------------

export const CONFIDENCES = ["high", "medium", "low"] as const;
export const confidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof confidenceSchema>;

// ---------------------------------------------------------------------------
// Modes and per-check states (§8.2 response `checks` object)
// ---------------------------------------------------------------------------

export const VERIFICATION_MODES = ["quick", "deep"] as const;
export const verificationModeSchema = z.enum(VERIFICATION_MODES);
export type VerificationMode = z.infer<typeof verificationModeSchema>;

export const CHECK_STATES = ["passed", "failed", "not_checked", "inconclusive"] as const;
export const checkStateSchema = z.enum(CHECK_STATES);
export type CheckState = z.infer<typeof checkStateSchema>;

export const verificationChecksSchema = z.object({
  syntax: checkStateSchema,
  domain: checkStateSchema,
  mx: checkStateSchema,
  smtp_mailbox: checkStateSchema,
});
export type VerificationChecks = z.infer<typeof verificationChecksSchema>;

// ---------------------------------------------------------------------------
// Verification result (§4.3: every result carries checks_performed,
// reason_codes, observed_at, mode and explanation)
// ---------------------------------------------------------------------------

export const verificationResultSchema = z.object({
  id: z.string().min(1).optional(),
  status: verificationStatusSchema,
  mode: verificationModeSchema,
  /** Qualitative evidence label only — not a probability (PRD §4.4). */
  confidence: confidenceSchema,
  /** The address as submitted (after outer-whitespace trim). */
  email: z.string().min(1).max(320),
  /** Normalized form: local part preserved, domain lowercased ASCII/punycode. */
  normalized_email: z.string().min(1).max(320).optional(),
  /** ASCII (punycode) domain, lowercased; null when syntax failed early. */
  domain: z.string().min(1).max(253).nullable(),
  checks: verificationChecksSchema,
  checks_performed: z.array(z.string().min(1)),
  reason_codes: z.array(reasonCodeSchema).min(1),
  explanation: z.string().min(1),
  /** ISO-8601 timestamp of when the evidence was observed. */
  observed_at: z.string().datetime(),
  /** Alias returned by the REST API (§8.2 example uses `checked_at`). */
  checked_at: z.string().datetime().optional(),
});
export type VerificationResultDto = z.infer<typeof verificationResultSchema>;

// ---------------------------------------------------------------------------
// §8.2 / §8.3 Requests
// ---------------------------------------------------------------------------

export const singleVerificationRequestSchema = z.object({
  email: z.string().min(1).max(320),
  mode: verificationModeSchema.default("quick"),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type SingleVerificationRequest = z.infer<typeof singleVerificationRequestSchema>;

export const JSON_BATCH_EMAIL_CAP = 1_000;

export const batchCreateRequestSchema = z.object({
  name: z.string().min(1).max(200),
  emails: z.array(z.string().min(1).max(320)).min(1).max(JSON_BATCH_EMAIL_CAP),
  mode: verificationModeSchema.default("quick"),
  webhook_url: z.string().url().nullable().default(null),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type BatchCreateRequest = z.infer<typeof batchCreateRequestSchema>;

export const batchFromUploadRequestSchema = z.object({
  name: z.string().min(1).max(200),
  upload_id: z.string().min(1),
  mode: verificationModeSchema.default("quick"),
  email_column: z.string().min(1).max(100).optional(),
  webhook_url: z.string().url().nullable().default(null),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type BatchFromUploadRequest = z.infer<typeof batchFromUploadRequestSchema>;

// ---------------------------------------------------------------------------
// §8.4 Batches
// ---------------------------------------------------------------------------

export const BATCH_STATUSES = [
  "queued",
  "processing",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
] as const;
export const batchStatusSchema = z.enum(BATCH_STATUSES);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const batchSummarySchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().uuid(),
  name: z.string(),
  mode: verificationModeSchema,
  status: batchStatusSchema,
  total_rows: z.number().int().nonnegative(),
  processed_rows: z.number().int().nonnegative(),
  duplicate_rows: z.number().int().nonnegative(),
  charged_checks: z.number().int().nonnegative(),
  counts_by_status: z.record(z.string(), z.number().int().nonnegative()),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type BatchSummaryDto = z.infer<typeof batchSummarySchema>;

export const batchRowResultSchema = z.object({
  row_number: z.number().int().positive(),
  disposition: rowDispositionSchema,
  /** Null for duplicate rows; the canonical row holds the mailbox status. */
  result: verificationResultSchema.nullable(),
  canonical_row_number: z.number().int().positive().nullable(),
  charged: z.boolean(),
});
export type BatchRowResultDto = z.infer<typeof batchRowResultSchema>;

// ---------------------------------------------------------------------------
// §8.5 Usage & §9 credit ledger
// ---------------------------------------------------------------------------

export const usageResponseSchema = z.object({
  workspace_id: z.string().uuid(),
  credits_balance: z.number().int(),
  credits_reserved: z.number().int().nonnegative(),
  billable_checks_current_period: z.number().int().nonnegative(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
});
export type UsageResponseDto = z.infer<typeof usageResponseSchema>;

export const CREDIT_LEDGER_REASONS = [
  "grant",
  "purchase",
  "reserve",
  "charge",
  "release",
  "refund",
  "adjustment",
  "expiry",
] as const;
export const creditLedgerReasonSchema = z.enum(CREDIT_LEDGER_REASONS);
export type CreditLedgerReason = z.infer<typeof creditLedgerReasonSchema>;

export const creditLedgerEntrySchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().uuid(),
  /** Positive credits in, negative credits out. Ledger is immutable (§9.1). */
  delta: z.number().int(),
  balance_after: z.number().int(),
  reason: creditLedgerReasonSchema,
  /** Every mutation carries an idempotency key to prevent double charging. */
  idempotency_key: z.string().min(1).max(200),
  verification_id: z.string().min(1).nullable(),
  batch_id: z.string().min(1).nullable(),
  created_at: z.string().datetime(),
});
export type CreditLedgerEntryDto = z.infer<typeof creditLedgerEntrySchema>;

// ---------------------------------------------------------------------------
// §8.1 API keys
// ---------------------------------------------------------------------------

export const API_KEY_SCOPES = ["verifications:read", "verifications:write", "batches:read", "batches:write", "usage:read"] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const apiKeyCreatedSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().uuid(),
  name: z.string(),
  key_prefix: z.string().min(1),
  /** Full secret — returned once at creation only, never stored (§8.1). */
  secret: z.string().min(1),
  scopes: z.array(apiKeyScopeSchema),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
});
export type ApiKeyCreatedDto = z.infer<typeof apiKeyCreatedSchema>;

// ---------------------------------------------------------------------------
// §8.6 Error envelope & §8.7 webhooks
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INSUFFICIENT_CREDITS",
  "RATE_LIMITED",
  "DEEP_SMTP_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    request_id: z.string().min(1),
    retry_after_seconds: z.number().int().nonnegative().optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

export const WEBHOOK_EVENTS = ["batch.completed", "batch.failed", "credits.low"] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookPayloadSchema = z.object({
  id: z.string().min(1),
  event: webhookEventSchema,
  created_at: z.string().datetime(),
  workspace_id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookPayloadDto = z.infer<typeof webhookPayloadSchema>;
