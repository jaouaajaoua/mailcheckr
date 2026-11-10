import { describe, it, expect } from "vitest";
import { mapDnsError, resolveDomainRouting, DnsResolutionError, type DnsResolver, type MxRecord } from "../src/dns";
import { verifyQuick } from "../src/verify";
import { FakeDnsResolver, PUBLIC_IP } from "./fakes";

const NOW = { now: () => new Date("2026-11-10T12:00:00.000Z") };

function rawError(code: string): Error & { code: string } {
  return Object.assign(new Error(`raw resolver failure ${code}`), { code });
}

/** Resolver whose MX lookup throws a RAW Node-style error (not pre-mapped). */
function mxThrowing(code: string): DnsResolver {
  return {
    resolveMx: async () => { throw rawError(code); },
    resolveA: async () => [],
    resolveAaaa: async () => [],
  };
}

describe("mapDnsError — distinct failure taxonomy", () => {
  const cases: Array<[string, string]> = [
    ["ENOTFOUND", "nxdomain"],
    ["ESERVFAIL", "servfail"],
    ["EREFUSED", "refused"],
    ["ETIMEOUT", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["ENODATA", "no_data"],
    ["EAI_AGAIN", "other_temporary"],
    ["ECONNREFUSED", "other_temporary"],
    ["ESOMETHINGELSE", "other_temporary"],
  ];
  for (const [code, kind] of cases) {
    it(`${code} → ${kind}`, () => {
      const err = mapDnsError(rawError(code), "lookup");
      expect(err).toBeInstanceOf(DnsResolutionError);
      expect(err.kind).toBe(kind);
      expect(err.code).toBe(code);
    });
  }

  it("passes an existing DnsResolutionError through unchanged", () => {
    const original = new DnsResolutionError("refused", "already mapped", "EREFUSED");
    expect(mapDnsError(original, "lookup")).toBe(original);
  });

  it("no infrastructure code ever maps to nxdomain", () => {
    for (const code of ["ESERVFAIL", "EREFUSED", "ETIMEOUT", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]) {
      expect(mapDnsError(rawError(code), "lookup").kind).not.toBe("nxdomain");
    }
  });
});

describe("resolveDomainRouting — distinct errorKind preserved", () => {
  const cases: Array<[string, string]> = [
    ["ESERVFAIL", "servfail"],
    ["EREFUSED", "refused"],
    ["ETIMEOUT", "timeout"],
    ["EAI_AGAIN", "other_temporary"],
  ];
  for (const [code, kind] of cases) {
    it(`MX ${code} → temporary_failure with errorKind ${kind}`, async () => {
      const routing = await resolveDomainRouting(mxThrowing(code), "example.com");
      expect(routing.kind).toBe("temporary_failure");
      if (routing.kind === "temporary_failure") expect(routing.errorKind).toBe(kind);
    });
  }

  it("MX ENOTFOUND → nxdomain routing (the only invalid-producing DNS failure)", async () => {
    const routing = await resolveDomainRouting(mxThrowing("ENOTFOUND"), "example.com");
    expect(routing.kind).toBe("nxdomain");
  });

  it("MX ENODATA → not a failure: falls through to implicit MX and can route ok", async () => {
    const resolver: DnsResolver = {
      resolveMx: async () => { throw rawError("ENODATA"); },
      resolveA: async () => [PUBLIC_IP],
      resolveAaaa: async () => [],
    };
    const routing = await resolveDomainRouting(resolver, "example.com");
    expect(routing.kind).toBe("ok");
    if (routing.kind === "ok") expect(routing.usedImplicitMx).toBe(true);
  });

  it("MX ENODATA + no A/AAAA (ENODATA again) → no_route, not temporary_failure", async () => {
    const resolver: DnsResolver = {
      resolveMx: async () => { throw rawError("ENODATA"); },
      resolveA: async () => { throw rawError("ENODATA"); },
      resolveAaaa: async () => { throw rawError("ENODATA"); },
    };
    const routing = await resolveDomainRouting(resolver, "example.com");
    expect(routing.kind).toBe("no_route");
  });

  it("MX-host address SERVFAIL preserves errorKind servfail (not lumped)", async () => {
    const resolver: DnsResolver = {
      resolveMx: async (): Promise<MxRecord[]> => [{ exchange: "mx.example.com", priority: 10 }],
      resolveA: async () => { throw rawError("ESERVFAIL"); },
      resolveAaaa: async () => { throw rawError("ESERVFAIL"); },
    };
    const routing = await resolveDomainRouting(resolver, "example.com");
    expect(routing.kind).toBe("temporary_failure");
    if (routing.kind === "temporary_failure") expect(routing.errorKind).toBe("servfail");
  });

  it("MX-host address REFUSED preserves errorKind refused", async () => {
    const resolver: DnsResolver = {
      resolveMx: async (): Promise<MxRecord[]> => [{ exchange: "mx.example.com", priority: 10 }],
      resolveA: async () => { throw rawError("EREFUSED"); },
      resolveAaaa: async () => [],
    };
    const routing = await resolveDomainRouting(resolver, "example.com");
    expect(routing.kind).toBe("temporary_failure");
    if (routing.kind === "temporary_failure") expect(routing.errorKind).toBe("refused");
  });

  it("pre-mapped DnsResolutionError kinds survive routing (refused)", async () => {
    const dns = new FakeDnsResolver({
      mx: { "example.com": new DnsResolutionError("refused", "MX lookup: REFUSED", "EREFUSED") },
    });
    const routing = await resolveDomainRouting(dns, "example.com");
    expect(routing.kind).toBe("temporary_failure");
    if (routing.kind === "temporary_failure") expect(routing.errorKind).toBe("refused");
  });
});

describe("verifyQuick — infrastructure failures are unknown, NEVER invalid", () => {
  const infraKinds = ["servfail", "refused", "timeout", "other_temporary"] as const;
  for (const kind of infraKinds) {
    it(`${kind} → unknown / dns_temporary_failure with dns_evidence.dns_error_kind=${kind}`, async () => {
      const dns = new FakeDnsResolver({
        mx: { "example.com": new DnsResolutionError(kind, `MX lookup failed: ${kind}`, "EWHATEVER") },
      });
      const r = await verifyQuick("person@example.com", { dns, ...NOW });
      expect(r.status).toBe("unknown");
      expect(r.status).not.toBe("invalid");
      expect(r.reason_codes).toEqual(["dns_temporary_failure"]);
      expect(r.confidence).toBe("low");
      expect(r.dns_evidence).toEqual({ dns_error_kind: kind, routing_kind: "temporary_failure" });
      expect(r.explanation).toContain(kind);
      expect(r.explanation).toContain("not evidence");
    });
  }

  it("raw SERVFAIL / REFUSED / timeout codes classify unknown with matching evidence kind", async () => {
    const pairs: Array<[string, string]> = [["ESERVFAIL", "servfail"], ["EREFUSED", "refused"], ["ETIMEOUT", "timeout"]];
    for (const [code, kind] of pairs) {
      const r = await verifyQuick("person@example.com", { dns: mxThrowing(code), ...NOW });
      expect(r.status).toBe("unknown");
      expect(r.reason_codes).toEqual(["dns_temporary_failure"]);
      expect(r.dns_evidence?.dns_error_kind).toBe(kind);
    }
  });

  it("NXDOMAIN remains invalid — and is the ONLY resolver failure that is", async () => {
    const r = await verifyQuick("person@example.com", { dns: mxThrowing("ENOTFOUND"), ...NOW });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["domain_nxdomain"]);
    expect(r.dns_evidence?.dns_error_kind).toBeNull();
  });

  it("successful routing carries dns_evidence with null error kind", async () => {
    const dns = new FakeDnsResolver({
      mx: { "example.com": [{ exchange: "mx.example.com", priority: 10 }] },
      a: { "mx.example.com": [PUBLIC_IP] },
    });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("likely_valid");
    expect(r.dns_evidence).toEqual({ dns_error_kind: null, routing_kind: "ok" });
  });
});
