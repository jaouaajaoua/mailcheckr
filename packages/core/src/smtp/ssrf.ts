import { isIP } from "node:net";

/**
 * SSRF guard for the SMTP worker (PRD §4.5 Stage 5, §10.3).
 *
 * The worker may only connect to PUBLIC mail-exchanger IPs derived from
 * the target domain's DNS. Loopback, private, link-local, multicast,
 * CGNAT, documentation, benchmarking, reserved and cloud-metadata
 * addresses are all blocked. The check is re-run against the final
 * resolved IP immediately before connecting (DNS rebinding / TOCTOU).
 */

function parseIpv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map((p) => Number(p));
}

function ipv4BlockReason(octets: number[]): string | null {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return "unspecified/this-network (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT shared address space (100.64.0.0/10)";
  if (a === 192 && b === 0 && octets[2] === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && octets[2] === 2) return "documentation TEST-NET-1 (192.0.2.0/24)";
  if (a === 198 && b === 51 && octets[2] === 100) return "documentation TEST-NET-2 (198.51.100.0/24)";
  if (a === 203 && b === 0 && octets[2] === 113) return "documentation TEST-NET-3 (203.0.113.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved / broadcast (240.0.0.0/4)";
  return null;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null. */
function parseIpv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let addr = ip.toLowerCase();
  // Embedded IPv4 tail, e.g. ::ffff:1.2.3.4
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let v4Groups: number[] = [];
  if (v4Match) {
    const o = v4Match[1]!.split(".").map(Number) as [number, number, number, number];
    v4Groups = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    addr = addr.slice(0, addr.length - v4Match[1]!.length).replace(/:$/, "");
    if (addr.endsWith(":")) addr = addr.slice(0, -1);
    if (addr === "") addr = "::";
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((h) => parseInt(h, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((h) => parseInt(h, 16)) : [];
  const missing = 8 - v4Groups.length - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array(Math.max(missing, 0)).fill(0), ...right, ...v4Groups];
  return groups.length === 8 ? groups : null;
}

function ipv6BlockReason(ip: string): string | null {
  const g = parseIpv6Groups(ip);
  if (!g) return "unparseable IPv6 address";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // IPv4-mapped ::ffff:a.b.c.d — judge by the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return ipv4BlockReason([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return "loopback (::1)";
  }
  if ((g0 & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g0 & 0xfe00) === 0xfc00) return "unique local (fc00::/7)";
  if ((g0 & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation (2001:db8::/32)";
  if (g0 === 0x0100) return "discard-only (100::/64)";
  // NAT64 well-known prefix embeds an IPv4 address — judge by it.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4BlockReason([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return null;
}

/** Why an IP is not a permitted public SMTP target, or null if it is. */
export function blockedIpReason(ip: string): string | null {
  const version = isIP(ip);
  if (version === 0) return "not a valid IP address";
  return version === 4 ? ipv4BlockReason(parseIpv4(ip)!) : ipv6BlockReason(ip);
}

/** True only for globally routable public unicast IPs. */
export function isPublicIp(ip: string): boolean {
  return blockedIpReason(ip) === null;
}
