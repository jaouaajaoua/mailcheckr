import { z } from "zod";

/**
 * Typed environment configuration for MailCheckr.
 *
 * Deep SMTP gate (PRD §5 Stage 5 / §6): Deep mode is enabled ONLY when
 * BOTH `SMTP_DEEP_ENABLED` and `SMTP_EGRESS_APPROVED` are true.
 * `SMTP_EGRESS_APPROVED` must be backed by Phase-0 evidence: a port-25
 * smoke test from the production worker network plus provider approval.
 * Either flag alone is never sufficient.
 */

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

export const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  HMAC_KEY: z.string().min(32, "HMAC_KEY must be at least 32 characters"),
  SMTP_DEEP_ENABLED: boolFromEnv.default(false),
  SMTP_EGRESS_APPROVED: boolFromEnv.default(false),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  SOURCE_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(1),
  FREE_CREDITS_GRANT: z.coerce.number().int().min(0).default(100),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type MailCheckrConfig = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): MailCheckrConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

/** Minimal dev/test defaults so the sandbox runs without a real .env. Never used to weaken the Deep gate. */
export function loadConfigWithDevDefaults(env: Record<string, string | undefined> = process.env): MailCheckrConfig {
  return loadConfig({
    JWT_SECRET: "dev-only-jwt-secret-at-least-32-chars!!",
    ENCRYPTION_KEY: "dev-only-encryption-key-at-least-32-chars",
    HMAC_KEY: "dev-only-hmac-key-at-least-32-characters",
    ...env,
  });
}

/**
 * The single source of truth for the Deep SMTP release gate.
 * Returns true only when the operator flag AND the provider-approval
 * flag are both true.
 */
export function isDeepSmtpEnabled(cfg: Pick<MailCheckrConfig, "SMTP_DEEP_ENABLED" | "SMTP_EGRESS_APPROVED">): boolean {
  return cfg.SMTP_DEEP_ENABLED === true && cfg.SMTP_EGRESS_APPROVED === true;
}
