import { promises as dns } from "node:dns";

/**
 * Stage 3 — DNS / domain routing (PRD §4.5).
 *
 * The resolver is an injectable interface so the verification core is
 * deterministically testable with a fake resolver and never needs live
 * network access in unit tests.
 *
 * Resolver contract — DISTINCT failure kinds (mandatory taxonomy):
 * - NXDOMAIN (the domain does not exist) is signalled by throwing a
 *   DnsResolutionError with kind "nxdomain". ONLY this kind (plus Null
 *   MX / a definitive SMTP rejection) may ever lead to `invalid`.
 * - SERVFAIL throws kind "servfail", REFUSED throws kind "refused",
 *   timeouts throw kind "timeout", ENODATA throws kind "no_data", and
 *   every other resolver failure throws kind "other_temporary".
 * - Infrastructure failures (servfail / refused / timeout /
 *   other_temporary) are NEVER evidence that an address is invalid:
 *   the classifier maps them all to `unknown` / dns_temporary_failure
 *   while preserving the distinct kind in the evidence payload.
 * - "No records of this type" (ENODATA / kind "no_data") is also
 *   surfaced as an empty result by NodeDnsResolver (resolveMx returns
 *   [] and resolveA/resolveAaaa return []), and resolveDomainRouting
 *   treats a thrown "no_data" the same way: no records, not a failure.
 */

export interface MxRecord {
  exchange: string;
  priority: number;
}

export type DnsErrorKind = "nxdomain" | "servfail" | "refused" | "timeout" | "no_data" | "other_temporary";

export class DnsResolutionError extends Error {
  readonly kind: DnsErrorKind;
  readonly code?: string;
  constructor(kind: DnsErrorKind, message: string, code?: string) {
    super(message);
    this.name = "DnsResolutionError";
    this.kind = kind;
    this.code = code;
  }
}

export interface DnsResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolveA(host: string): Promise<string[]>;
  resolveAaaa(host: string): Promise<string[]>;
}

/**
 * Map a raw resolver error to its DISTINCT kind. Node codes:
 * ENOTFOUND→nxdomain, ESERVFAIL→servfail, EREFUSED→refused,
 * ETIMEOUT/ETIMEDOUT→timeout, ENODATA→no_data, anything else (EAI_AGAIN,
 * ECONNREFUSED, …)→other_temporary. Infrastructure kinds must never be
 * conflated with nxdomain.
 */
export function mapDnsError(err: unknown, what: string): DnsResolutionError {
  if (err instanceof DnsResolutionError) return err;
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOTFOUND") return new DnsResolutionError("nxdomain", `${what}: NXDOMAIN (${message})`, code);
  if (code === "ESERVFAIL") return new DnsResolutionError("servfail", `${what}: SERVFAIL (${message})`, code);
  if (code === "EREFUSED") return new DnsResolutionError("refused", `${what}: REFUSED (${message})`, code);
  if (code === "ETIMEOUT" || code === "ETIMEDOUT") return new DnsResolutionError("timeout", `${what}: timeout (${message})`, code);
  if (code === "ENODATA") return new DnsResolutionError("no_data", `${what}: no records of this type (${message})`, code);
  return new DnsResolutionError("other_temporary", `${what}: temporary DNS failure ${code ?? ""} (${message})`, code);
}

/** Production resolver backed by node:dns/promises. */
export class NodeDnsResolver implements DnsResolver {
  async resolveMx(domain: string): Promise<MxRecord[]> {
    try {
      const records = await dns.resolveMx(domain);
      return records
        .map((r) => ({ exchange: r.exchange, priority: r.priority }))
        .sort((a, b) => a.priority - b.priority);
    } catch (err) {
      if ((err as { code?: string })?.code === "ENODATA") return [];
      throw mapDnsError(err, `MX lookup for ${domain}`);
    }
  }

  async resolveA(host: string): Promise<string[]> {
    try {
      return await dns.resolve4(host);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw mapDnsError(err, `A lookup for ${host}`);
    }
  }

  async resolveAaaa(host: string): Promise<string[]> {
    try {
      return await dns.resolve6(host);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw mapDnsError(err, `AAAA lookup for ${host}`);
    }
  }
}

export interface ResolvedHost {
  exchange: string;
  addresses: string[];
}

/**
 * Discriminated routing outcome. Keeping NXDOMAIN, temporary failure,
 * Null MX, implicit-MX and unresolved-MX-host as separate kinds is what
 * lets the classifier assign the correct distinct reason codes.
 */
export type DomainRouting =
  | { kind: "nxdomain"; domain: string }
  | { kind: "temporary_failure"; domain: string; errorKind: DnsErrorKind }
  | { kind: "null_mx"; domain: string; mxRecords: MxRecord[] }
  | { kind: "mx_host_unresolved"; domain: string; mxRecords: MxRecord[]; hosts: ResolvedHost[] }
  | { kind: "no_route"; domain: string; usedImplicitMx: true }
  | {
      kind: "ok";
      domain: string;
      mxRecords: MxRecord[];
      usedImplicitMx: boolean;
      hosts: ResolvedHost[];
    };

async function resolveHostAddresses(resolver: DnsResolver, host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([resolver.resolveA(host), resolver.resolveAaaa(host)]);
  return [...a, ...aaaa];
}

/**
 * Resolve mail routing for a domain:
 * 1. MX lookup. A single `0 .` record is Null MX (RFC 7505).
 * 2. When MX records exist, resolve every exchange's A/AAAA. The implicit
 *    fallback is NOT applied in this branch, even if all hosts fail.
 * 3. Only when there are NO MX records at all, apply the SMTP implicit-MX
 *    fallback to the domain's own A/AAAA records.
 */
export async function resolveDomainRouting(resolver: DnsResolver, domain: string): Promise<DomainRouting> {
  let mxRecords: MxRecord[];
  try {
    mxRecords = await resolver.resolveMx(domain);
  } catch (err) {
    const dnsErr = mapDnsError(err, `MX lookup for ${domain}`);
    if (dnsErr.kind === "nxdomain") return { kind: "nxdomain", domain };
    if (dnsErr.kind !== "no_data") return { kind: "temporary_failure", domain, errorKind: dnsErr.kind };
    // ENODATA: the domain exists but publishes no MX records — exactly
    // the empty-result case, so fall through to the implicit-MX check.
    mxRecords = [];
  }

  if (mxRecords.length > 0) {
    const isNullMx = mxRecords.some((r) => r.exchange === "." || r.exchange === "");
    if (isNullMx) return { kind: "null_mx", domain, mxRecords };
    const hosts: ResolvedHost[] = [];
    let temporaryKind: DnsErrorKind | null = null;
    for (const record of mxRecords) {
      const exchange = record.exchange.replace(/\.$/, "");
      try {
        hosts.push({ exchange, addresses: await resolveHostAddresses(resolver, exchange) });
      } catch (err) {
        const dnsErr = mapDnsError(err, `address lookup for ${exchange}`);
        if (dnsErr.kind === "nxdomain" || dnsErr.kind === "no_data") {
          // Host has no addresses — not an infrastructure failure.
          hosts.push({ exchange, addresses: [] });
        } else {
          // Preserve the DISTINCT kind (servfail/refused/timeout/…)
          // instead of lumping every failure into one bucket.
          temporaryKind ??= dnsErr.kind;
          hosts.push({ exchange, addresses: [] });
        }
      }
    }
    if (hosts.some((h) => h.addresses.length > 0)) {
      return { kind: "ok", domain, mxRecords, usedImplicitMx: false, hosts };
    }
    if (temporaryKind) return { kind: "temporary_failure", domain, errorKind: temporaryKind };
    return { kind: "mx_host_unresolved", domain, mxRecords, hosts };
  }

  // No MX records at all → implicit MX fallback (RFC 5321 §5.1).
  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(resolver, domain);
  } catch (err) {
    const dnsErr = mapDnsError(err, `implicit-MX address lookup for ${domain}`);
    if (dnsErr.kind === "nxdomain") return { kind: "nxdomain", domain };
    if (dnsErr.kind !== "no_data") return { kind: "temporary_failure", domain, errorKind: dnsErr.kind };
    addresses = []; // ENODATA → no A/AAAA → the no_route branch below.
  }
  if (addresses.length === 0) return { kind: "no_route", domain, usedImplicitMx: true };
  return {
    kind: "ok",
    domain,
    mxRecords: [],
    usedImplicitMx: true,
    hosts: [{ exchange: domain, addresses }],
  };
}
