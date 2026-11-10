import { describe, it, expect } from "vitest";
import { verifyQuick } from "../src/verify";
import { DnsResolutionError } from "../src/dns";
import { FakeDnsResolver, dnsWithMx, PUBLIC_IP } from "./fakes";

const NOW = { now: () => new Date("2026-11-10T12:00:00.000Z") };

describe("verifyQuick — classification (PRD §4.5 Stage 4)", () => {
  it("syntax failure → invalid / syntax_invalid / high", async () => {
    const r = await verifyQuick("not an email", { dns: dnsWithMx(), ...NOW });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["syntax_invalid"]);
    expect(r.confidence).toBe("high");
    expect(r.mode).toBe("quick");
    expect(r.observed_at).toBe("2026-11-10T12:00:00.000Z");
  });

  it("valid syntax + MX → likely_valid, NEVER valid, with smtp_not_attempted_quick_mode", async () => {
    const r = await verifyQuick("person@example.com", { dns: dnsWithMx(), ...NOW });
    expect(r.status).toBe("likely_valid");
    expect(r.reason_codes).toEqual(["smtp_not_attempted_quick_mode"]);
    expect(r.confidence).toBe("medium");
    expect(r.checks).toEqual({ syntax: "passed", domain: "passed", mx: "passed", smtp_mailbox: "not_checked" });
    expect(r.explanation).toContain("not tested in Quick mode");
  });

  it("SMTPUTF8 local part → unknown / internationalized_local_part_unsupported, DNS untouched", async () => {
    const dns = dnsWithMx();
    const r = await verifyQuick("üser@example.com", { dns, ...NOW });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["internationalized_local_part_unsupported"]);
    expect(dns.mxCalls).toEqual([]);
  });

  it("punycode domain is what gets looked up in DNS", async () => {
    const dns = dnsWithMx("xn--mnchen-3ya.de");
    const r = await verifyQuick("user@münchen.de", { dns, ...NOW });
    expect(dns.mxCalls).toEqual(["xn--mnchen-3ya.de"]);
    expect(r.domain).toBe("xn--mnchen-3ya.de");
    expect(r.status).toBe("likely_valid");
  });

  it("NXDOMAIN → invalid / domain_nxdomain", async () => {
    const dns = new FakeDnsResolver({
      mx: { "gone.example.com": new DnsResolutionError("nxdomain", "MX lookup: NXDOMAIN", "ENOTFOUND") },
    });
    const r = await verifyQuick("person@gone.example.com", { dns, ...NOW });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["domain_nxdomain"]);
    expect(r.confidence).toBe("high");
  });

  it("SERVFAIL → unknown / dns_temporary_failure, evidence kind servfail (distinct from NXDOMAIN)", async () => {
    const dns = new FakeDnsResolver({
      mx: { "example.com": new DnsResolutionError("servfail", "MX lookup: SERVFAIL", "ESERVFAIL") },
    });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["dns_temporary_failure"]);
    expect(r.dns_evidence?.dns_error_kind).toBe("servfail");
  });

  it("DNS timeout → unknown / dns_temporary_failure, evidence kind timeout", async () => {
    const dns = new FakeDnsResolver({
      mx: { "example.com": new DnsResolutionError("timeout", "MX lookup: timeout", "ETIMEOUT") },
    });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["dns_temporary_failure"]);
    expect(r.dns_evidence?.dns_error_kind).toBe("timeout");
  });

  it("Null MX (MX 0 .) → invalid / null_mx", async () => {
    const dns = new FakeDnsResolver({ mx: { "example.com": [{ exchange: ".", priority: 0 }] } });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["null_mx"]);
    expect(r.confidence).toBe("high");
  });

  it("no MX + A record → implicit MX fallback → likely_valid with mx_missing_implicit_route_checked", async () => {
    const dns = new FakeDnsResolver({ mx: { "example.com": [] }, a: { "example.com": [PUBLIC_IP] } });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("likely_valid");
    expect(r.reason_codes).toContain("mx_missing_implicit_route_checked");
    expect(r.reason_codes).toContain("smtp_not_attempted_quick_mode");
    expect(r.checks_performed).toContain("dns_implicit_mx");
  });

  it("no MX + no A/AAAA → invalid with mx_missing_implicit_route_checked", async () => {
    const dns = new FakeDnsResolver({ mx: { "example.com": [] }, a: {}, aaaa: {} });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["mx_missing_implicit_route_checked"]);
  });

  it("MX present but hosts unresolved → unknown / mx_host_unresolved, implicit fallback NOT applied", async () => {
    // The domain itself HAS an A record; if the code wrongly applied the
    // implicit fallback in the MX-present branch it would succeed.
    const dns = new FakeDnsResolver({
      mx: { "example.com": [{ exchange: "mx.example.com", priority: 10 }] },
      a: { "example.com": [PUBLIC_IP], "mx.example.com": [] },
      aaaa: { "mx.example.com": [] },
    });
    const r = await verifyQuick("person@example.com", { dns, ...NOW });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["mx_host_unresolved"]);
  });

  it("disposable domain → risky / disposable_domain", async () => {
    const r = await verifyQuick("person@mailinator.com", { dns: dnsWithMx("mailinator.com"), ...NOW });
    expect(r.status).toBe("risky");
    expect(r.reason_codes).toEqual(["disposable_domain"]);
  });

  it("role account → risky / role_account (not invalid)", async () => {
    const r = await verifyQuick("support@example.com", { dns: dnsWithMx(), ...NOW });
    expect(r.status).toBe("risky");
    expect(r.reason_codes).toEqual(["role_account"]);
  });

  it("segmented role account (sales.eu@) → risky / role_account", async () => {
    const r = await verifyQuick("sales.eu@example.com", { dns: dnsWithMx(), ...NOW });
    expect(r.status).toBe("risky");
    expect(r.reason_codes).toContain("role_account");
  });

  it("free provider → likely_valid with free_provider as metadata reason", async () => {
    const r = await verifyQuick("person@gmail.com", { dns: dnsWithMx("gmail.com", "gmail-smtp-in.l.google.com"), ...NOW });
    expect(r.status).toBe("likely_valid");
    expect(r.reason_codes).toEqual(["free_provider", "smtp_not_attempted_quick_mode"]);
  });

  it("duplicate spellings normalize to the same domain result", async () => {
    const a = await verifyQuick("Person@EXAMPLE.com", { dns: dnsWithMx(), ...NOW });
    const b = await verifyQuick("person@example.com", { dns: dnsWithMx(), ...NOW });
    expect(a.status).toBe(b.status);
    expect(a.normalized_email?.split("@")[1]).toBe("example.com");
    expect(a.domain).toBe(b.domain);
  });
});
