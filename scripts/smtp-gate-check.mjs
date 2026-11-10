#!/usr/bin/env node
/**
 * smtp-gate-check.mjs — MailCheckr Phase 0 / PRD §6.2 network gate probe.
 *
 * Run this ON A REAL PRODUCTION CANDIDATE HOST (never treat sandbox/CI
 * results as gate evidence). It checks whether that host can perform the
 * network operations Deep SMTP verification would need:
 *
 *   1. MX resolution for controlled domains (gmail.com, example.com,
 *      outlook.com) using BOTH the system resolver and an explicit
 *      8.8.8.8 resolver.
 *   2. A TCP connection to the first public MX host of each domain on
 *      port 25 (6 s timeout), reading the server's banner.
 *
 * SAFETY INVARIANTS
 *   - It NEVER sends email and NEVER issues the SMTP DATA command.
 *   - The only bytes it sends after connecting are "QUIT\r\n".
 *   - It tests only the controlled domains listed below — never
 *     user-supplied domains.
 *
 * OUTPUT / EXIT CODE
 *   Prints a single JSON evidence object (timestamp, egress IP, per-domain
 *   MX + TCP results, verdict) to stdout.
 *   Exit 0  → verdict PASS (all MX lookups succeeded AND ≥2 TCP/25 connects)
 *   Exit 1  → verdict BLOCKED (anything else) — Deep SMTP must stay disabled.
 *
 * Passing this script is necessary but NOT sufficient: the provider's
 * written approval and PTR/rDNS setup are also required (see
 * docs/phase-0-audit.md §4.1).
 */
import dns from "node:dns/promises";
import net from "node:net";

const CONTROLLED_DOMAINS = ["gmail.com", "example.com", "outlook.com"];
const TCP_TIMEOUT_MS = 6000;
const PUBLIC_RESOLVER = "8.8.8.8";

const BLOCKED_PREFIXES = [
  "0.", "10.", "127.", "169.254.", "192.168.", "224.", "240.",
];
function isPrivateOrReserved(ip) {
  if (BLOCKED_PREFIXES.some((p) => ip.startsWith(p))) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/** Connect to host:25, capture the banner line, send QUIT, close. Never DATA. */
function probeTcp25(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port: 25 });
    let banner = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.end("QUIT\r\n");
      } catch {
        /* socket already gone */
      }
      socket.destroy();
      resolve({ host, duration_ms: Date.now() - started, ...result });
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => {
      // Connected: wait briefly for the banner in the data handler; a server
      // that accepts TCP but never greets still proves port 25 is open.
    });
    socket.on("data", (chunk) => {
      banner += chunk.toString("utf8");
      const line = banner.split("\r\n")[0].slice(0, 200);
      finish({ connected: true, banner: line });
    });
    socket.once("timeout", () => finish({ connected: false, error: `timeout after ${TCP_TIMEOUT_MS}ms` }));
    socket.once("error", (err) => finish({ connected: false, error: `${err.code ?? "ERROR"}: ${err.message}` }));
    // Some MX hosts accept the connection but delay the greeting; treat a
    // bare connect held for 3 s as connected-without-banner evidence.
    setTimeout(() => {
      if (!settled && !socket.destroyed && socket.readyState === "open") {
        finish({ connected: true, banner: null, note: "TCP connected; no banner within 3s" });
      }
    }, 3000).unref();
  });
}

async function getEgressIp() {
  try {
    const res = await fetch("https://ifconfig.me/ip", {
      signal: AbortSignal.timeout(5000),
      headers: { "user-agent": "mailcheckr-smtp-gate-check" },
    });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null; // egress-IP lookup is best-effort evidence, not a gate input
  }
}

async function resolveMx(resolver, domain) {
  try {
    const records = await resolver.resolveMx(domain);
    return { ok: true, records: records.map((r) => ({ exchange: r.exchange, priority: r.priority })) };
  } catch (err) {
    return { ok: false, error: `${err.code ?? "ERROR"}: ${err.message}` };
  }
}

async function resolveA(resolver, host) {
  try {
    return await resolver.resolve4(host);
  } catch {
    return [];
  }
}

async function main() {
  const publicResolver = new dns.Resolver();
  publicResolver.setServers([PUBLIC_RESOLVER]);

  const results = [];
  for (const domain of CONTROLLED_DOMAINS) {
    const systemMx = await resolveMx(dns, domain);
    const publicMx = await resolveMx(publicResolver, domain);
    const mx = systemMx.ok ? systemMx : publicMx;
    const entry = { domain, mx_system: systemMx, mx_public_resolver: publicMx, tcp25: null };
    if (mx.ok && mx.records.length > 0) {
      const exchange = mx.records.sort((a, b) => a.priority - b.priority)[0].exchange;
      const ips = await resolveA(dns, exchange);
      const publicIp = ips.find((ip) => !isPrivateOrReserved(ip));
      if (publicIp) {
        entry.tcp25 = await probeTcp25(publicIp);
        entry.tcp25.exchange = exchange;
      } else {
        entry.tcp25 = { connected: false, exchange, error: `no public A record resolved for ${exchange}` };
      }
    } else {
      entry.tcp25 = { connected: false, error: "no MX records available to probe" };
    }
    results.push(entry);
  }

  const mxOkCount = results.filter((r) => r.mx_system.ok || r.mx_public_resolver.ok).length;
  const tcpOkCount = results.filter((r) => r.tcp25?.connected).length;
  const pass = mxOkCount === CONTROLLED_DOMAINS.length && tcpOkCount >= 2;

  const evidence = {
    tool: "mailcheckr-smtp-gate-check",
    version: 1,
    timestamp: new Date().toISOString(),
    egress_ip: await getEgressIp(),
    controlled_domains: CONTROLLED_DOMAINS,
    tcp_timeout_ms: TCP_TIMEOUT_MS,
    data_command_sent: false,
    email_sent: false,
    results,
    summary: { mx_resolved: mxOkCount, tcp25_connected: tcpOkCount },
    verdict: pass ? "PASS" : "BLOCKED",
    next_steps: pass
      ? "File this output WITH the provider's written port-25 approval and PTR/rDNS verification; only then set SMTP_DEEP_ENABLED=true and SMTP_EGRESS_APPROVED=true for the worker."
      : "Deep SMTP stays disabled. Do not tunnel or substitute a third-party verifier (PRD §6.3).",
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(
    `${JSON.stringify({ tool: "mailcheckr-smtp-gate-check", timestamp: new Date().toISOString(), verdict: "BLOCKED", fatal_error: String(err) }, null, 2)}\n`,
  );
  process.exit(1);
});
