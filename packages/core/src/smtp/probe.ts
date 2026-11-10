import { blockedIpReason } from "./ssrf";
import { readSmtpResponse, collectExtensions, type SmtpResponse } from "./parser";
import { assertNotDataCommand, type SmtpTransport } from "./transport";

/**
 * Deep SMTP probe state machine (PRD §4.5 Stage 5).
 *
 * Sequence: greeting → EHLO → STARTTLS (REQUIRED) → TLS handshake →
 * EHLO → MAIL FROM → RCPT TO → RSET → QUIT.
 *
 * Hard rules:
 * - NEVER issue DATA. Every command goes through sendCommand(), which
 *   throws DataCommandForbiddenError if a DATA command is attempted;
 *   the transport write layer guards again.
 * - If STARTTLS is not advertised, abort BEFORE MAIL FROM/RCPT TO so the
 *   target address is never transmitted in cleartext.
 * - Connect only to a validated public IP (SSRF guard re-checked here).
 * - Connected-peer verification (DNS rebinding / TOCTOU): immediately
 *   after connect, the socket's ACTUAL peer IP (transport.remoteAddress)
 *   must be a public IP inside the validated resolved set for the MX
 *   host; otherwise the probe aborts BEFORE the greeting/EHLO — no
 *   SMTP command is ever sent over an unverified connection — with
 *   outcome kind "peer_ip_mismatch" (evidence flag peer_ip_mismatch).
 * - Conservative RCPT interpretation: only an unambiguous enhanced
 *   5.1.1 is a definitive mailbox rejection. A generic 550 is a policy
 *   rejection (unknown), never "invalid".
 */

export type SmtpProbeOutcome =
  | { kind: "accepted"; response: SmtpResponse }
  | { kind: "rejected_definitive"; response: SmtpResponse }
  | { kind: "policy_rejected"; response: SmtpResponse }
  | { kind: "provider_defers"; response: SmtpResponse }
  | { kind: "greylisted"; response: SmtpResponse }
  | { kind: "rate_limited"; response: SmtpResponse | null }
  | { kind: "starttls_unavailable" }
  | { kind: "tls_handshake_failed"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "connection_refused"; message: string }
  | { kind: "port_unavailable"; message: string }
  | { kind: "blocked_non_public_ip"; ip: string; reason: string }
  | {
      kind: "peer_ip_mismatch";
      /** Evidence flag: the connected peer failed verification. */
      peer_ip_mismatch: true;
      /** The validated resolved IPs the peer was expected to be one of. */
      expected: string[];
      /** The socket's actual peer IP, or null if it could not be read. */
      actual: string | null;
      reason: string;
    }
  | { kind: "protocol_error"; message: string };

export interface SmtpProbeOptions {
  transport: SmtpTransport;
  /** Public IP the transport will connect to (validated here). */
  ip: string;
  /** MX host name — used for TLS servername and diagnostics. */
  host: string;
  port?: number;
  /** Controlled probe identity domain (EHLO argument). */
  heloDomain: string;
  /** Controlled probe sender address — never a user-supplied identity. */
  mailFrom: string;
  /** Target recipient to probe at RCPT stage only. */
  targetEmail: string;
  /**
   * The validated/resolved public IP set for the MX host, as produced
   * by the DNS stage. After connect, the socket's actual peer IP must
   * be in this set. Defaults to `[ip]` (the address being dialed).
   */
  expectedPeerIps?: string[];
}

/** Strip an IPv4-mapped IPv6 wrapper (::ffff:1.2.3.4 → 1.2.3.4). */
function normalizePeerIp(ip: string): string {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1]! : ip;
}

/**
 * Verify the connected socket's actual peer against the validated set.
 * Returns a peer_ip_mismatch outcome, or null when the peer is verified.
 */
function verifyConnectedPeer(
  transport: SmtpTransport,
  expectedPeerIps: string[],
): Extract<SmtpProbeOutcome, { kind: "peer_ip_mismatch" }> | null {
  const expected = expectedPeerIps.map(normalizePeerIp);
  const rawActual = transport.remoteAddress();
  const actual = rawActual === null ? null : normalizePeerIp(rawActual);
  const mismatch = (reason: string): Extract<SmtpProbeOutcome, { kind: "peer_ip_mismatch" }> => ({
    kind: "peer_ip_mismatch",
    peer_ip_mismatch: true,
    expected,
    actual,
    reason,
  });
  if (actual === null) return mismatch("connected peer address unavailable; cannot verify the connection target");
  const blocked = blockedIpReason(actual);
  if (blocked) return mismatch(`connected peer ${actual} is not a public IP: ${blocked}`);
  if (!expected.includes(actual)) {
    return mismatch(`connected peer ${actual} is not in the validated resolved IP set [${expected.join(", ")}] (possible DNS rebinding)`);
  }
  return null;
}

const RATE_LIMIT_HINT = /rate|too many|throttl|limit exceeded|try again later/i;
const DEFER_HINT = /cannot verify|unable to verify|will be accepted|after data|verify.*later/i;

/**
 * Interpret an RCPT TO reply conservatively (PRD §4.5 Stage 5, §4.2):
 * - 250/251 accepted
 * - 252 "cannot VRFY but will accept" → provider defers validation
 * - enhanced 5.1.1 → definitive mailbox-not-found (the ONLY definitive)
 * - 450/451 and other 4xx → greylisted (unknown), unless rate-limit hints
 * - 452 / rate-limit hints → rate limited (unknown)
 * - any other 5xx (incl. generic 550) → policy rejected (unknown)
 */
export function interpretRcptResponse(response: SmtpResponse): SmtpProbeOutcome {
  const { code, enhancedCode } = response;
  const text = `${response.message} ${response.lines.join(" ")}`;
  if (code === 250 || code === 251) {
    if (DEFER_HINT.test(text)) return { kind: "provider_defers", response };
    return { kind: "accepted", response };
  }
  if (code === 252) return { kind: "provider_defers", response };
  if (enhancedCode === "5.1.1") return { kind: "rejected_definitive", response };
  if (code === 452 || (code >= 400 && code < 500 && RATE_LIMIT_HINT.test(text))) {
    return { kind: "rate_limited", response };
  }
  if (code >= 400 && code < 500) return { kind: "greylisted", response };
  if (code >= 500 && code < 600) {
    if (RATE_LIMIT_HINT.test(text)) return { kind: "rate_limited", response };
    return { kind: "policy_rejected", response };
  }
  return { kind: "protocol_error", message: `Unexpected RCPT reply code ${code}` };
}

function mapTransportError(err: unknown): SmtpProbeOutcome {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) return { kind: "timeout", message };
  if (code === "ECONNREFUSED") return { kind: "connection_refused", message };
  if (code === "ECONNRESET" || code === "EPIPE" || /closed/i.test(message)) {
    return { kind: "port_unavailable", message };
  }
  return { kind: "protocol_error", message };
}

async function sendCommand(transport: SmtpTransport, line: string): Promise<void> {
  // Hard guard: the DATA command can never be issued, by construction.
  assertNotDataCommand(line);
  if (/[\r\n]/.test(line)) throw new Error("SMTP command contains CR/LF");
  await transport.writeLine(line);
}

export async function probeSmtpMailbox(options: SmtpProbeOptions): Promise<SmtpProbeOutcome> {
  const { transport, ip, host, heloDomain, mailFrom, targetEmail } = options;
  const port = options.port ?? 25;

  const blocked = blockedIpReason(ip);
  if (blocked) return { kind: "blocked_non_public_ip", ip, reason: blocked };
  if (/[\r\n]/.test(targetEmail) || /[\r\n]/.test(mailFrom)) {
    return { kind: "protocol_error", message: "Probe addresses contain CR/LF" };
  }

  try {
    try {
      await transport.connect(ip, port);
    } catch (err) {
      return mapTransportError(err);
    }

    // DNS-rebinding / TOCTOU defense: verify the ACTUAL connected peer
    // before reading the greeting or sending any command. On mismatch
    // we abort here — the finally block destroys the socket — and no
    // EHLO/MAIL/RCPT is ever issued over the unverified connection.
    const peerMismatch = verifyConnectedPeer(transport, options.expectedPeerIps ?? [ip]);
    if (peerMismatch) return peerMismatch;

    const greeting = await readSmtpResponse(transport);
    if (greeting.code !== 220) {
      if (greeting.code === 421) return { kind: "rate_limited", response: greeting };
      if (greeting.code === 554) return { kind: "policy_rejected", response: greeting };
      return { kind: "port_unavailable", message: `SMTP greeting was ${greeting.code}, expected 220` };
    }

    await sendCommand(transport, `EHLO ${heloDomain}`);
    const ehlo = await readSmtpResponse(transport);
    if (ehlo.code !== 250) return { kind: "protocol_error", message: `EHLO rejected with ${ehlo.code}` };

    // STARTTLS is required before the target address may be transmitted.
    if (!collectExtensions(ehlo).has("STARTTLS")) {
      await sendCommand(transport, "QUIT").catch(() => undefined);
      return { kind: "starttls_unavailable" };
    }
    await sendCommand(transport, "STARTTLS");
    const tlsReply = await readSmtpResponse(transport);
    if (tlsReply.code !== 220) {
      return { kind: "starttls_unavailable" };
    }
    try {
      await transport.startTls(host);
    } catch (err) {
      return { kind: "tls_handshake_failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (!transport.isSecure()) {
      return { kind: "tls_handshake_failed", message: "Transport did not report a secure connection after STARTTLS" };
    }

    await sendCommand(transport, `EHLO ${heloDomain}`);
    const ehlo2 = await readSmtpResponse(transport);
    if (ehlo2.code !== 250) return { kind: "protocol_error", message: `Post-TLS EHLO rejected with ${ehlo2.code}` };

    await sendCommand(transport, `MAIL FROM:<${mailFrom}>`);
    const mail = await readSmtpResponse(transport);
    if (mail.code !== 250) {
      if (mail.code >= 400 && mail.code < 500) {
        return RATE_LIMIT_HINT.test(mail.message) ? { kind: "rate_limited", response: mail } : { kind: "greylisted", response: mail };
      }
      if (mail.code >= 500) return { kind: "policy_rejected", response: mail };
      return { kind: "protocol_error", message: `MAIL FROM rejected with ${mail.code}` };
    }

    await sendCommand(transport, `RCPT TO:<${targetEmail}>`);
    const rcpt = await readSmtpResponse(transport);
    const outcome = interpretRcptResponse(rcpt);

    // Polite teardown; failures here do not change the outcome.
    await sendCommand(transport, "RSET").catch(() => undefined);
    await readSmtpResponse(transport).catch(() => undefined);
    await sendCommand(transport, "QUIT").catch(() => undefined);
    await readSmtpResponse(transport).catch(() => undefined);
    return outcome;
  } catch (err) {
    // DataCommandForbiddenError and programming errors must surface, not
    // be disguised as a network outcome.
    if (err instanceof Error && err.name === "DataCommandForbiddenError") throw err;
    return mapTransportError(err);
  } finally {
    await transport.close().catch(() => undefined);
  }
}
