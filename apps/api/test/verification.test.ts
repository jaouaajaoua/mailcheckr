import { describe, it, expect } from "vitest";
import { VerificationService } from "../src/verification/verification.service";
import { fakeDns, OK_MX } from "./helpers";

const svc = (table: any) => new VerificationService(fakeDns(table));

describe("VerificationService — Quick via @mailcheckr/core (PRD §4)", () => {
  it("syntax + MX pass => likely_valid, never valid, reason smtp_not_attempted_quick_mode", async () => {
    const r = await svc({ "example.com": OK_MX }).verifyQuick("person@example.com");
    expect(r.status).toBe("likely_valid");
    expect(r.reasonCodes).toContain("smtp_not_attempted_quick_mode");
    expect(r.billable).toBe(true);
  });
  it("bad syntax => invalid/syntax_invalid", async () => {
    const r = await svc({}).verifyQuick("not-an-email");
    expect(r.status).toBe("invalid"); expect(r.reasonCodes).toContain("syntax_invalid");
  });
  it("NXDOMAIN => invalid/domain_nxdomain", async () => {
    const r = await svc({}).verifyQuick("a@missing.example.com");
    expect(r.status).toBe("invalid"); expect(r.reasonCodes).toContain("domain_nxdomain");
  });
  it("Null MX => invalid/null_mx", async () => {
    const r = await svc({ "example.com": { mx: [{ exchange: ".", priority: 0 }] } }).verifyQuick("a@example.com");
    expect(r.status).toBe("invalid"); expect(r.reasonCodes).toContain("null_mx");
  });
  it("no MX + A record => likely_valid with implicit-route reason; no MX + no A => invalid", async () => {
    const ok = await svc({ "example.com": { mx: [], a: ["192.0.2.10"] } }).verifyQuick("a@example.com");
    expect(ok.status).toBe("likely_valid"); expect(ok.reasonCodes).toContain("mx_missing_implicit_route_checked");
    const bad = await svc({ "example.com": { mx: [], a: [] } }).verifyQuick("a@example.com");
    expect(bad.status).toBe("invalid"); expect(bad.reasonCodes).toContain("mx_missing_implicit_route_checked");
  });
  it("MX present but hosts unresolved => unknown/mx_host_unresolved, not billable", async () => {
    const r = await svc({ "example.com": { mx: [{ exchange: "mx.example.com", priority: 10 }] }, "mx.example.com": { a: [] } }).verifyQuick("a@example.com");
    expect(r.status).toBe("unknown"); expect(r.reasonCodes).toContain("mx_host_unresolved"); expect(r.billable).toBe(false);
  });
  it("DNS temporary failure => unknown, not billable", async () => {
    const r = await svc({ "example.com": { error: "servfail" } }).verifyQuick("a@example.com");
    expect(r.status).toBe("unknown"); expect(r.billable).toBe(false); expect(r.reasonCodes).toContain("dns_temporary_failure");
  });
  it("INFRA DNS failures (SERVFAIL/REFUSED/TIMEOUT) => unknown + dns_temporary_failure, NEVER invalid", async () => {
    for (const error of ["servfail", "refused", "timeout"] as const) {
      const r = await svc({ "example.com": { error } }).verifyQuick("a@example.com");
      expect(r.status).toBe("unknown");
      expect(r.status).not.toBe("invalid");
      expect(r.reasonCodes).toContain("dns_temporary_failure");
      expect(r.billable).toBe(false);
    }
  });
  it("disposable => risky; role => risky; free provider is metadata only", async () => {
    const d = await svc({ "mailinator.com": OK_MX }).verifyQuick("a@mailinator.com");
    expect(d.status).toBe("risky"); expect(d.reasonCodes).toContain("disposable_domain");
    const role = await svc({ "example.com": OK_MX }).verifyQuick("support@example.com");
    expect(role.status).toBe("risky"); expect(role.reasonCodes).toContain("role_account");
    const free = await svc({ "gmail.com": OK_MX }).verifyQuick("person@gmail.com");
    expect(free.status).toBe("likely_valid"); expect(free.reasonCodes).toContain("free_provider");
  });
});

describe("Deep mode gate (PRD §6)", () => {
  it("mode=deep with gate OFF => never valid, reason smtp_port_unavailable, explanation honest", async () => {
    const r = await svc({ "example.com": OK_MX }).verify("person@example.com", "deep", { deepEnabled: false });
    expect(r.status).toBe("likely_valid");
    expect(r.status).not.toBe("valid");
    expect(r.reasonCodes).toContain("smtp_port_unavailable");
    expect(r.explanation).toMatch(/port 25|not tested/i);
    expect(r.checks.smtp_mailbox).toBe("not_checked");
  });
  it("mode=deep gate OFF keeps definitive invalid evidence", async () => {
    const r = await svc({}).verify("a@missing.example.com", "deep", { deepEnabled: false });
    expect(r.status).toBe("invalid");
    expect(r.reasonCodes).toContain("smtp_port_unavailable");
  });
});
