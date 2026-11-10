import { describe, it, expect } from "vitest";
import { verifyDeep, classifyDeep } from "../src/verify";
import { parseEmail } from "../src/normalize";
import { parseSmtpResponseLines } from "../src/smtp/parser";
import type { SmtpProbeOutcome } from "../src/smtp/probe";
import { dnsWithMx, FakeDnsResolver } from "./fakes";

const NOW = { now: () => new Date("2026-11-10T12:00:00.000Z") };
const resp = (line: string) => parseSmtpResponseLines([line]);

function deepWith(outcome: SmtpProbeOutcome, catchAll?: "suspected" | "not_catch_all" | "unchecked" | "none") {
  return verifyDeep("person@example.com", {
    dns: dnsWithMx(),
    probeMailbox: async () => outcome,
    checkCatchAll:
      catchAll === undefined || catchAll === "none"
        ? undefined
        : async () =>
            catchAll === "suspected"
              ? { kind: "suspected" as const, syntheticRecipient: "mc-probe-x@example.com" }
              : catchAll === "not_catch_all"
                ? { kind: "not_catch_all" as const, syntheticRecipient: "mc-probe-x@example.com" }
                : { kind: "unchecked" as const, syntheticRecipient: "mc-probe-x@example.com", detail: "blocked" },
    ...NOW,
  });
}

describe("verifyDeep — conservative SMTP classification (PRD §4.5 Stages 5–6)", () => {
  it("accepted + conclusively not catch-all → valid / smtp_mailbox_accepted", async () => {
    const r = await deepWith({ kind: "accepted", response: resp("250 2.1.5 OK") }, "not_catch_all");
    expect(r.status).toBe("valid");
    expect(r.reason_codes).toEqual(["smtp_mailbox_accepted"]);
    expect(r.mode).toBe("deep");
    expect(r.explanation).toContain("not guaranteed inbox delivery");
  });

  it("accepted + catch-all suspected → risky / catch_all_suspected", async () => {
    const r = await deepWith({ kind: "accepted", response: resp("250 OK") }, "suspected");
    expect(r.status).toBe("risky");
    expect(r.reason_codes).toEqual(["smtp_mailbox_accepted", "catch_all_suspected"]);
  });

  it("accepted + catch-all unchecked → likely_valid / catch_all_unchecked (never valid)", async () => {
    const r = await deepWith({ kind: "accepted", response: resp("250 OK") }, "unchecked");
    expect(r.status).toBe("likely_valid");
    expect(r.reason_codes).toEqual(["smtp_mailbox_accepted", "catch_all_unchecked"]);
  });

  it("accepted + no catch-all prober at all → likely_valid / catch_all_unchecked", async () => {
    const r = await deepWith({ kind: "accepted", response: resp("250 OK") }, "none");
    expect(r.status).toBe("likely_valid");
    expect(r.reason_codes).toContain("catch_all_unchecked");
  });

  it("enhanced 5.1.1 → invalid / smtp_mailbox_rejected_definitive", async () => {
    const r = await deepWith({ kind: "rejected_definitive", response: resp("550 5.1.1 User unknown") });
    expect(r.status).toBe("invalid");
    expect(r.reason_codes).toEqual(["smtp_mailbox_rejected_definitive"]);
    expect(r.confidence).toBe("high");
  });

  it("generic 550 policy rejection → unknown / smtp_policy_rejected (NOT invalid)", async () => {
    const r = await deepWith({ kind: "policy_rejected", response: resp("550 Access denied") });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["smtp_policy_rejected"]);
  });

  it("provider defers until DATA → unknown / provider_defers_recipient_validation", async () => {
    const r = await deepWith({ kind: "provider_defers", response: resp("252 Cannot verify") });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["provider_defers_recipient_validation"]);
  });

  const unknownTable: Array<[SmtpProbeOutcome, string]> = [
    [{ kind: "greylisted", response: resp("451 4.7.1 Greylisted") }, "smtp_greylisted"],
    [{ kind: "rate_limited", response: resp("452 Too many") }, "smtp_rate_limited"],
    [{ kind: "starttls_unavailable" }, "smtp_starttls_unavailable"],
    [{ kind: "tls_handshake_failed", message: "bad cert" }, "smtp_tls_handshake_failed"],
    [{ kind: "timeout", message: "timed out" }, "smtp_connection_timeout"],
    [{ kind: "connection_refused", message: "refused" }, "smtp_connection_refused"],
    [{ kind: "port_unavailable", message: "no service" }, "smtp_port_unavailable"],
    [{ kind: "protocol_error", message: "weird" }, "smtp_port_unavailable"],
  ];
  for (const [outcome, code] of unknownTable) {
    it(`${outcome.kind} → unknown / ${code}`, async () => {
      const r = await deepWith(outcome);
      expect(r.status).toBe("unknown");
      expect(r.reason_codes).toEqual([code]);
      expect(r.confidence).toBe("low");
    });
  }

  it("peer_ip_mismatch → unknown / smtp_port_unavailable (rebinding defense, never invalid)", async () => {
    const r = await deepWith({
      kind: "peer_ip_mismatch",
      peer_ip_mismatch: true,
      expected: ["93.184.216.34"],
      actual: "192.168.1.10",
      reason: "connected peer 192.168.1.10 is not a public IP: private (192.168.0.0/16)",
    });
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("invalid");
    expect(r.reason_codes).toEqual(["smtp_port_unavailable"]);
    expect(r.confidence).toBe("low");
    expect(r.explanation).toContain("did not match the validated");
  });

  it("no prober configured → unknown / smtp_port_unavailable (Deep is never faked)", async () => {
    const r = await verifyDeep("person@example.com", { dns: dnsWithMx(), ...NOW });
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["smtp_port_unavailable"]);
  });

  it("MX resolving only to a private IP → unknown / smtp_port_unavailable, prober never called", async () => {
    let probed = false;
    const dns = new FakeDnsResolver({
      mx: { "example.com": [{ exchange: "mx.example.com", priority: 10 }] },
      a: { "mx.example.com": ["192.168.0.10"] },
    });
    const r = await verifyDeep("person@example.com", {
      dns,
      probeMailbox: async () => {
        probed = true;
        return { kind: "accepted", response: resp("250 OK") };
      },
      ...NOW,
    });
    expect(probed).toBe(false);
    expect(r.status).toBe("unknown");
    expect(r.reason_codes).toEqual(["smtp_port_unavailable"]);
  });

  it("deep still short-circuits DNS failures and disposable domains before any probe", async () => {
    let probed = false;
    const probeMailbox = async (): Promise<SmtpProbeOutcome> => {
      probed = true;
      return { kind: "accepted", response: resp("250 OK") };
    };
    const disposable = await verifyDeep("person@mailinator.com", {
      dns: dnsWithMx("mailinator.com"), probeMailbox, ...NOW,
    });
    expect(disposable.status).toBe("risky");
    expect(disposable.reason_codes).toEqual(["disposable_domain"]);
    expect(probed).toBe(false);
  });

  it("free-provider reasons carry through deep classification", async () => {
    const parsed = parseEmail("person@gmail.com");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = classifyDeep({
      normalized: parsed.value,
      baseReasonCodes: ["free_provider"],
      checksPerformed: ["syntax", "dns_mx"],
      smtpOutcome: { kind: "accepted", response: resp("250 OK") },
      catchAllOutcome: { kind: "not_catch_all", syntheticRecipient: "mc-probe-x@gmail.com" },
      observedAt: "2026-11-10T12:00:00.000Z",
    });
    expect(r.status).toBe("valid");
    expect(r.reason_codes).toEqual(["free_provider", "smtp_mailbox_accepted"]);
  });
});
