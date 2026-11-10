/**
 * Config for the API process. Delegates to @mailcheckr/config semantics
 * (zod validation + the two-flag Deep SMTP gate) with a self-contained
 * implementation so the API stays runnable before workspace linking.
 * Keep in sync with packages/config/src/index.ts.
 */
export interface ApiConfig {
  DATABASE_URL?: string; REDIS_URL?: string;
  JWT_SECRET: string; ENCRYPTION_KEY: string; HMAC_KEY: string;
  SMTP_DEEP_ENABLED: boolean; SMTP_EGRESS_APPROVED: boolean;
  API_PORT: number; RESULT_RETENTION_DAYS: number; SOURCE_RETENTION_HOURS: number; FREE_CREDITS_GRANT: number;
  NODE_ENV: "development" | "test" | "production";
}
const bool = (v: string | undefined, d = false) => (v == null ? d : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));
export function loadConfigWithDevDefaults(env: Record<string, string | undefined> = process.env): ApiConfig {
  const cfg: ApiConfig = {
    DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL,
    JWT_SECRET: env.JWT_SECRET ?? "dev-only-jwt-secret-at-least-32-chars!!",
    ENCRYPTION_KEY: env.ENCRYPTION_KEY ?? "dev-only-encryption-key-at-least-32-chars",
    HMAC_KEY: env.HMAC_KEY ?? "dev-only-hmac-key-at-least-32-characters",
    SMTP_DEEP_ENABLED: bool(env.SMTP_DEEP_ENABLED), SMTP_EGRESS_APPROVED: bool(env.SMTP_EGRESS_APPROVED),
    // Default 4000 — matches docker-compose, .env.example and the web
    // client's NEXT_PUBLIC_API_URL default (http://localhost:4000).
    API_PORT: Number(env.API_PORT ?? env.PORT ?? 4000), RESULT_RETENTION_DAYS: Number(env.RETENTION_DAYS ?? env.RESULT_RETENTION_DAYS ?? 7),
    SOURCE_RETENTION_HOURS: Number(env.SOURCE_RETENTION_HOURS ?? (env.SOURCE_RETENTION_DAYS ? Number(env.SOURCE_RETENTION_DAYS) * 24 : 24)),
    FREE_CREDITS_GRANT: Number(env.FREE_CREDITS_GRANT ?? 100),
    NODE_ENV: (env.NODE_ENV as ApiConfig["NODE_ENV"]) ?? "development",
  };
  for (const k of ["JWT_SECRET", "ENCRYPTION_KEY", "HMAC_KEY"] as const) {
    if (cfg[k].length < 32) throw new Error(`Invalid environment configuration: ${k} must be at least 32 characters`);
  }
  if (cfg.NODE_ENV === "production" && cfg.JWT_SECRET.startsWith("dev-only")) throw new Error("Refusing to start in production with dev-default secrets");
  return cfg;
}
export function isDeepSmtpEnabled(cfg: Pick<ApiConfig, "SMTP_DEEP_ENABLED" | "SMTP_EGRESS_APPROVED">): boolean {
  return cfg.SMTP_DEEP_ENABLED === true && cfg.SMTP_EGRESS_APPROVED === true;
}
