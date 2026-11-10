import { DnsResolutionError, type DnsResolver, type MxRecord } from "@mailcheckr/core";

/** Controlled DNS fixture implementing @mailcheckr/core's resolver contract —
 * no live DNS in tests (PRD §13.2). Unknown domains throw NXDOMAIN. */
export interface FakeDomainSpec { mx?: MxRecord[]; a?: string[]; error?: "nxdomain" | "servfail" | "refused" | "timeout"; }
export const OK_MX: FakeDomainSpec = { mx: [{ exchange: "mx.example.com", priority: 10 }], a: ["192.0.2.10"] };

export function fakeDns(table: Record<string, FakeDomainSpec>): DnsResolver {
  return {
    async resolveMx(domain: string) {
      const spec = table[domain];
      if (!spec) throw new DnsResolutionError("nxdomain", `NXDOMAIN ${domain}`);
      if (spec.error) throw new DnsResolutionError(spec.error, `${spec.error} ${domain}`);
      return spec.mx ?? [];
    },
    async resolveA(host: string) {
      const spec = table[host];
      if (spec?.a !== undefined) return spec.a;
      return ["192.0.2.10"]; // TEST-NET-1 default so MX hosts resolve
    },
    async resolveAaaa() { return []; },
  };
}
export const testConfig = {
  JWT_SECRET: "test-jwt-secret-at-least-32-characters!",
  ENCRYPTION_KEY: "test-encryption-key-at-least-32-chars",
  HMAC_KEY: "test-hmac-key-at-least-32-characters!",
  SMTP_DEEP_ENABLED: false, SMTP_EGRESS_APPROVED: false,
  API_PORT: 4000, RESULT_RETENTION_DAYS: 7, SOURCE_RETENTION_HOURS: 24, FREE_CREDITS_GRANT: 100, NODE_ENV: "test" as const,
};
