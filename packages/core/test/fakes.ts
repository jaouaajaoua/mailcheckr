import { DnsResolutionError, type DnsResolver, type MxRecord } from "../src/dns";
import type { SmtpTransport } from "../src/smtp/transport";

/** Deterministic in-memory DnsResolver. No live network in tests. */
export class FakeDnsResolver implements DnsResolver {
  mxCalls: string[] = [];
  aCalls: string[] = [];
  constructor(
    private readonly opts: {
      mx?: Record<string, MxRecord[] | DnsResolutionError>;
      a?: Record<string, string[]>;
      aaaa?: Record<string, string[]>;
    } = {},
  ) {}

  async resolveMx(domain: string): Promise<MxRecord[]> {
    this.mxCalls.push(domain);
    const v = this.opts.mx?.[domain];
    if (v instanceof DnsResolutionError) throw v;
    return v ?? [];
  }
  async resolveA(host: string): Promise<string[]> {
    this.aCalls.push(host);
    return this.opts.a?.[host] ?? [];
  }
  async resolveAaaa(host: string): Promise<string[]> {
    return this.opts.aaaa?.[host] ?? [];
  }
}

export const PUBLIC_IP = "93.184.216.34";

export function dnsWithMx(domain = "example.com", exchange = "mx.example.com", ip = PUBLIC_IP): FakeDnsResolver {
  return new FakeDnsResolver({
    mx: { [domain]: [{ exchange, priority: 10 }] },
    a: { [exchange]: [ip] },
  });
}

/**
 * Scripted SmtpTransport. `script` is the flat list of reply lines the
 * server sends, in order. Every line the client writes is recorded in
 * `commands` so tests can assert exactly what was (and was not) sent.
 */
export class FakeSmtpTransport implements SmtpTransport {
  commands: string[] = [];
  connectedTo: { host: string; port: number } | null = null;
  closed = false;
  private lines: string[];
  private secureFlag = false;
  private peer: string | null = null;

  constructor(
    script: string[],
    private readonly opts: {
      connectError?: Error & { code?: string };
      tlsError?: Error;
      /**
       * Peer IP the socket reports after connect. Defaults to the host
       * passed to connect() (a faithful connection). Pass an explicit
       * value — including a private IP — to simulate DNS rebinding /
       * TOCTOU, or null to simulate an unverifiable peer.
       */
      peerAddress?: string | null;
    } = {},
  ) {
    this.lines = [...script];
  }

  async connect(host: string, port: number): Promise<void> {
    if (this.opts.connectError) throw this.opts.connectError;
    this.connectedTo = { host, port };
    this.peer = "peerAddress" in this.opts ? (this.opts.peerAddress ?? null) : host;
  }
  remoteAddress(): string | null {
    return this.peer;
  }
  async readLine(): Promise<string> {
    const line = this.lines.shift();
    if (line === undefined) throw new Error("SMTP connection closed (script exhausted)");
    return line;
  }
  async writeLine(line: string): Promise<void> {
    this.commands.push(line);
  }
  async startTls(_servername: string): Promise<void> {
    if (this.opts.tlsError) throw this.opts.tlsError;
    this.secureFlag = true;
  }
  isSecure(): boolean {
    return this.secureFlag;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Standard happy-path server script up to (and excluding) the RCPT reply. */
export function scriptThroughMailFrom(rcptReply: string[], opts: { starttls?: boolean } = {}): string[] {
  const ehlo = opts.starttls === false
    ? ["250-mx.example.com greets probe.mailcheckr.example", "250 SMTPUTF8"]
    : ["250-mx.example.com greets probe.mailcheckr.example", "250-STARTTLS", "250 SMTPUTF8"];
  return [
    "220 mx.example.com ESMTP ready",
    ...ehlo,
    "220 2.0.0 Ready to start TLS",
    "250-mx.example.com greets probe.mailcheckr.example",
    "250 SMTPUTF8",
    "250 2.1.0 Sender OK",
    ...rcptReply,
    "250 2.0.0 Reset OK",
    "221 2.0.0 Bye",
  ];
}

export const PROBE_OPTS = {
  ip: PUBLIC_IP,
  host: "mx.example.com",
  heloDomain: "probe.mailcheckr.example",
  mailFrom: "probe@probe.mailcheckr.example",
  targetEmail: "person@example.com",
} as const;
