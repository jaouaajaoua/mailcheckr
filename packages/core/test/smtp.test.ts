import { describe, it, expect } from "vitest";
import { parseSmtpResponseLines, collectExtensions, readSmtpResponse } from "../src/smtp/parser";
import { probeSmtpMailbox, interpretRcptResponse } from "../src/smtp/probe";
import { assertNotDataCommand, DataCommandForbiddenError, NodeSmtpTransport } from "../src/smtp/transport";
import { isPublicIp, blockedIpReason } from "../src/smtp/ssrf";
import { checkCatchAll, generateSyntheticLocalPart } from "../src/smtp/catchall";
import { FakeSmtpTransport, scriptThroughMailFrom, PROBE_OPTS, PUBLIC_IP } from "./fakes";

describe("SMTP reply parser", () => {
  it("parses a single-line reply with an enhanced code", () => {
    const r = parseSmtpResponseLines(["550 5.1.1 User unknown"]);
    expect(r.code).toBe(550);
    expect(r.enhancedCode).toBe("5.1.1");
    expect(r.message).toBe("User unknown");
  });
  it("parses a generic 550 with NO enhanced code (must not imply 5.1.1)", () => {
    const r = parseSmtpResponseLines(["550 Requested action not taken"]);
    expect(r.code).toBe(550);
    expect(r.enhancedCode).toBeNull();
  });
  it("parses multi-line replies and collects the final line's enhanced code", () => {
    const r = parseSmtpResponseLines(["250-mx.example.com", "250-STARTTLS", "250 2.0.0 SMTPUTF8"]);
    expect(r.code).toBe(250);
    expect(r.enhancedCode).toBe("2.0.0");
    expect(r.lines).toHaveLength(3);
  });
  it("collects EHLO extensions from continuation lines", () => {
    const r = parseSmtpResponseLines(["250-mx.example.com", "250-STARTTLS", "250 SMTPUTF8"]);
    expect(collectExtensions(r).has("STARTTLS")).toBe(true);
    expect(collectExtensions(r).has("SMTPUTF8")).toBe(true);
  });
  it("rejects malformed lines and inconsistent multi-line codes", () => {
    expect(() => parseSmtpResponseLines(["garbage"])).toThrow();
    expect(() => parseSmtpResponseLines(["250-one", "251 two"])).toThrow();
  });
  it("readSmtpResponse consumes exactly one multi-line response", async () => {
    const lines = ["250-first", "250 second", "221 bye"];
    const source = { readLine: async () => lines.shift()! };
    const r = await readSmtpResponse(source);
    expect(r.code).toBe(250);
    expect(lines).toEqual(["221 bye"]);
  });
});

describe("interpretRcptResponse — conservative mapping", () => {
  const resp = (line: string) => parseSmtpResponseLines([line]);
  it("250 → accepted", () => expect(interpretRcptResponse(resp("250 2.1.5 Recipient OK")).kind).toBe("accepted"));
  it("252 → provider_defers", () => expect(interpretRcptResponse(resp("252 Cannot verify user but will accept")).kind).toBe("provider_defers"));
  it("550 with enhanced 5.1.1 → rejected_definitive", () =>
    expect(interpretRcptResponse(resp("550 5.1.1 User unknown")).kind).toBe("rejected_definitive"));
  it("generic 550 without 5.1.1 → policy_rejected, NOT definitive", () =>
    expect(interpretRcptResponse(resp("550 Access denied")).kind).toBe("policy_rejected"));
  it("554 generic → policy_rejected", () =>
    expect(interpretRcptResponse(resp("554 5.7.1 Relay access denied")).kind).toBe("policy_rejected"));
  it("451 → greylisted", () => expect(interpretRcptResponse(resp("451 4.7.1 Greylisting in action")).kind).toBe("greylisted"));
  it("450 → greylisted", () => expect(interpretRcptResponse(resp("450 4.2.0 Mailbox busy")).kind).toBe("greylisted"));
  it("452 → rate_limited", () => expect(interpretRcptResponse(resp("452 4.3.2 Too many recipients")).kind).toBe("rate_limited"));
  it("450 with rate-limit wording → rate_limited", () =>
    expect(interpretRcptResponse(resp("450 Rate limit exceeded, try again later")).kind).toBe("rate_limited"));
});

describe("probeSmtpMailbox state machine (fake transport, no network)", () => {
  it("happy path: greeting→EHLO→STARTTLS→EHLO→MAIL→RCPT→RSET→QUIT and accepted", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 2.1.5 Recipient OK"]));
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("accepted");
    expect(t.connectedTo).toEqual({ host: PROBE_OPTS.ip, port: 25 });
    expect(t.commands).toEqual([
      `EHLO ${PROBE_OPTS.heloDomain}`,
      "STARTTLS",
      `EHLO ${PROBE_OPTS.heloDomain}`,
      `MAIL FROM:<${PROBE_OPTS.mailFrom}>`,
      `RCPT TO:<${PROBE_OPTS.targetEmail}>`,
      "RSET",
      "QUIT",
    ]);
    expect(t.closed).toBe(true);
  });

  it("NEVER sends DATA in any flow", async () => {
    for (const rcpt of [["250 OK"], ["550 5.1.1 Nope"], ["451 Greylisted"], ["252 Cannot verify"]]) {
      const t = new FakeSmtpTransport(scriptThroughMailFrom(rcpt));
      await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
      expect(t.commands.some((c) => /^\s*DATA(\s|$)/i.test(c))).toBe(false);
    }
  });

  it("hard guard: assertNotDataCommand and the Node transport both refuse DATA", async () => {
    expect(() => assertNotDataCommand("DATA")).toThrow(DataCommandForbiddenError);
    expect(() => assertNotDataCommand("data ")).toThrow(DataCommandForbiddenError);
    expect(() => assertNotDataCommand("RCPT TO:<a@b.co>")).not.toThrow();
    const nodeTransport = new NodeSmtpTransport();
    expect(() => nodeTransport.writeLine("DATA")).toThrow(DataCommandForbiddenError);
  });

  it("STARTTLS not advertised → starttls_unavailable, aborts BEFORE MAIL FROM/RCPT (no cleartext target)", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"], { starttls: false }));
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("starttls_unavailable");
    expect(t.commands).toEqual([`EHLO ${PROBE_OPTS.heloDomain}`, "QUIT"]);
    expect(t.commands.join(" ")).not.toContain(PROBE_OPTS.targetEmail);
    expect(t.commands.join(" ")).not.toContain("RCPT");
  });

  it("TLS handshake failure → tls_handshake_failed, RCPT never sent", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { tlsError: new Error("certificate expired") });
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("tls_handshake_failed");
    expect(t.commands.join(" ")).not.toContain("RCPT");
  });

  it("connect timeout → timeout; connection refused → connection_refused", async () => {
    const timeoutErr = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    const t1 = new FakeSmtpTransport([], { connectError: timeoutErr });
    expect((await probeSmtpMailbox({ transport: t1, ...PROBE_OPTS })).kind).toBe("timeout");
    const refusedErr = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const t2 = new FakeSmtpTransport([], { connectError: refusedErr });
    expect((await probeSmtpMailbox({ transport: t2, ...PROBE_OPTS })).kind).toBe("connection_refused");
  });

  it("non-public target IP → blocked_non_public_ip and the transport never connects", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]));
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS, ip: "169.254.169.254" });
    expect(outcome.kind).toBe("blocked_non_public_ip");
    expect(t.connectedTo).toBeNull();
    expect(t.commands).toEqual([]);
  });

  it("421 greeting → rate_limited", async () => {
    const t = new FakeSmtpTransport(["421 4.7.0 Too many connections, try later"]);
    expect((await probeSmtpMailbox({ transport: t, ...PROBE_OPTS })).kind).toBe("rate_limited");
  });

  it("554 greeting → policy_rejected", async () => {
    const t = new FakeSmtpTransport(["554 5.7.1 Service unavailable"]);
    expect((await probeSmtpMailbox({ transport: t, ...PROBE_OPTS })).kind).toBe("policy_rejected");
  });
});

describe("probeSmtpMailbox — connected peer IP verification (DNS rebinding / TOCTOU)", () => {
  it("matching peer proceeds through the full happy path", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 2.1.5 Recipient OK"]), { peerAddress: PUBLIC_IP });
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("accepted");
    expect(t.commands).toContain(`RCPT TO:<${PROBE_OPTS.targetEmail}>`);
  });

  it("peer defaults to the dialed IP when the transport does not override it", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]));
    expect((await probeSmtpMailbox({ transport: t, ...PROBE_OPTS })).kind).toBe("accepted");
    expect(t.remoteAddress()).toBe(PUBLIC_IP);
  });

  it("mismatched PUBLIC peer aborts BEFORE EHLO/MAIL/RCPT — no command is ever sent", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: "8.8.8.8" });
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("peer_ip_mismatch");
    if (outcome.kind === "peer_ip_mismatch") {
      expect(outcome.peer_ip_mismatch).toBe(true);
      expect(outcome.expected).toEqual([PUBLIC_IP]);
      expect(outcome.actual).toBe("8.8.8.8");
    }
    expect(t.commands).toEqual([]); // no EHLO, no MAIL FROM, no RCPT, no greeting read side-effects
    expect(t.commands.join(" ")).not.toContain("RCPT");
    expect(t.closed).toBe(true);
  });

  it("PRIVATE peer aborts even though DNS returned a public IP (rebinding to internal target)", async () => {
    for (const privatePeer of ["192.168.1.10", "10.0.0.5", "169.254.169.254", "127.0.0.1"]) {
      const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: privatePeer });
      const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
      expect(outcome.kind).toBe("peer_ip_mismatch");
      if (outcome.kind === "peer_ip_mismatch") {
        expect(outcome.peer_ip_mismatch).toBe(true);
        expect(outcome.actual).toBe(privatePeer);
        expect(outcome.reason).toContain("not a public IP");
      }
      expect(t.commands).toEqual([]);
    }
  });

  it("unavailable peer address (null) aborts — unverifiable is not trusted", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: null });
    const outcome = await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(outcome.kind).toBe("peer_ip_mismatch");
    if (outcome.kind === "peer_ip_mismatch") expect(outcome.actual).toBeNull();
    expect(t.commands).toEqual([]);
  });

  it("peer in a multi-IP validated set proceeds (expectedPeerIps)", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: "8.8.4.4" });
    const outcome = await probeSmtpMailbox({
      transport: t, ...PROBE_OPTS,
      expectedPeerIps: [PUBLIC_IP, "8.8.4.4"],
    });
    expect(outcome.kind).toBe("accepted");
  });

  it("peer outside a multi-IP validated set aborts", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: "1.1.1.1" });
    const outcome = await probeSmtpMailbox({
      transport: t, ...PROBE_OPTS,
      expectedPeerIps: [PUBLIC_IP, "8.8.4.4"],
    });
    expect(outcome.kind).toBe("peer_ip_mismatch");
    expect(t.commands).toEqual([]);
  });

  it("IPv4-mapped IPv6 peer (::ffff:a.b.c.d) matches its validated IPv4 entry", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: `::ffff:${PUBLIC_IP}` });
    expect((await probeSmtpMailbox({ transport: t, ...PROBE_OPTS })).kind).toBe("accepted");
  });

  it("peer mismatch flow never issues DATA either", async () => {
    const t = new FakeSmtpTransport(scriptThroughMailFrom(["250 OK"]), { peerAddress: "10.1.2.3" });
    await probeSmtpMailbox({ transport: t, ...PROBE_OPTS });
    expect(t.commands.some((c) => /^\s*DATA(\s|$)/i.test(c))).toBe(false);
  });
});

describe("isPublicIp / blockedIpReason — SSRF table", () => {
  const blocked: Array<[string, string]> = [
    ["10.0.0.5", "private"],
    ["172.16.3.4", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.53.0.9", "loopback"],
    ["169.254.169.254", "metadata / link-local"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.2.10", "TEST-NET-1"],
    ["198.51.100.7", "TEST-NET-2"],
    ["203.0.113.9", "TEST-NET-3"],
    ["198.18.0.5", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["::1", "v6 loopback"],
    ["::", "v6 unspecified"],
    ["fe80::1", "v6 link-local"],
    ["fd00::1", "v6 unique local"],
    ["ff02::1", "v6 multicast"],
    ["2001:db8::1", "v6 documentation"],
    ["::ffff:192.168.0.1", "v4-mapped private"],
    ["::ffff:169.254.169.254", "v4-mapped metadata"],
    ["not-an-ip", "garbage"],
  ];
  for (const [ip] of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isPublicIp(ip)).toBe(false);
      expect(blockedIpReason(ip)).not.toBeNull();
    });
  }
  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "2001:4860:4860::8888"];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => {
      expect(isPublicIp(ip)).toBe(true);
      expect(blockedIpReason(ip)).toBeNull();
    });
  }
});

describe("catch-all probe", () => {
  const fixedRandom = () => Buffer.from("00112233445566778899aabb", "hex");
  it("generates a crypto-random synthetic local part (deterministic under injection)", () => {
    expect(generateSyntheticLocalPart(fixedRandom)).toBe("mc-probe-00112233445566778899aabb");
    const a = generateSyntheticLocalPart();
    const b = generateSyntheticLocalPart();
    expect(a).toMatch(/^mc-probe-[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
  it("synthetic accepted → suspected", async () => {
    const outcome = await checkCatchAll({
      createTransport: () => new FakeSmtpTransport(scriptThroughMailFrom(["250 2.1.5 OK"])),
      domain: "example.com", ip: PROBE_OPTS.ip, host: PROBE_OPTS.host,
      heloDomain: PROBE_OPTS.heloDomain, mailFrom: PROBE_OPTS.mailFrom, random: fixedRandom,
    });
    expect(outcome.kind).toBe("suspected");
    if (outcome.kind === "suspected") expect(outcome.syntheticRecipient).toBe("mc-probe-00112233445566778899aabb@example.com");
  });
  it("synthetic definitively rejected → not_catch_all", async () => {
    const outcome = await checkCatchAll({
      createTransport: () => new FakeSmtpTransport(scriptThroughMailFrom(["550 5.1.1 User unknown"])),
      domain: "example.com", ip: PROBE_OPTS.ip, host: PROBE_OPTS.host,
      heloDomain: PROBE_OPTS.heloDomain, mailFrom: PROBE_OPTS.mailFrom, random: fixedRandom,
    });
    expect(outcome.kind).toBe("not_catch_all");
  });
  it("synthetic probe inconclusive (greylisted) → unchecked, never suspected", async () => {
    const outcome = await checkCatchAll({
      createTransport: () => new FakeSmtpTransport(scriptThroughMailFrom(["451 4.7.1 Greylisted"])),
      domain: "example.com", ip: PROBE_OPTS.ip, host: PROBE_OPTS.host,
      heloDomain: PROBE_OPTS.heloDomain, mailFrom: PROBE_OPTS.mailFrom, random: fixedRandom,
    });
    expect(outcome.kind).toBe("unchecked");
  });
});
