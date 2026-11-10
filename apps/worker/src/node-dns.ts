import { promises as dns } from "node:dns";
import type { DnsResolver, DnsResult } from "./verify";

export class NodeDnsResolver implements DnsResolver {
  async lookupDomain(domain: string): Promise<DnsResult> {
    let mx: { exchange: string; priority: number }[] = [];
    try { mx = await dns.resolveMx(domain); }
    catch (e: any) {
      if (e?.code === "ENOTFOUND" || e?.code === "NXDOMAIN") return { status: "nxdomain", mx: [], hasAddressRecord: false, isNullMx: false };
      if (e?.code === "ESERVFAIL") return { status: "servfail", mx: [], hasAddressRecord: false, isNullMx: false };
      if (e?.code === "ETIMEOUT" || e?.code === "ETIMEDOUT") return { status: "timeout", mx: [], hasAddressRecord: false, isNullMx: false };
      if (e?.code !== "ENODATA") return { status: "error", mx: [], hasAddressRecord: false, isNullMx: false };
    }
    const isNullMx = mx.length === 1 && (mx[0].exchange === "." || mx[0].exchange === "");
    let hasAddressRecord = false;
    if (mx.length === 0) {
      const [a, aaaa] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
      hasAddressRecord = (a.status === "fulfilled" && a.value.length > 0) || (aaaa.status === "fulfilled" && aaaa.value.length > 0);
    }
    return { status: "ok", mx, hasAddressRecord, isNullMx };
  }
}
