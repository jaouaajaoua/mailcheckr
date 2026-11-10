import { domainToASCII } from "node:url";

/**
 * Stage 1 — Normalize and parse (PRD §4.5).
 *
 * - Trims outer whitespace, preserves the original input.
 * - Lowercases the DOMAIN only; the local part is never silently rewritten.
 * - Converts internationalized domains to ASCII/punycode for DNS lookup.
 * - Records whether the local part requires SMTPUTF8.
 * - Rejects control characters, CRLF injection, embedded whitespace and
 *   malformed values. This is a structural parser, not a single regex:
 *   dot-atom and quoted-string local parts are validated segment by segment.
 */

export interface NormalizedEmail {
  /** Input exactly as supplied by the caller. */
  original: string;
  /** Trimmed input before normalization. */
  trimmed: string;
  /** Local part exactly as written (case preserved). */
  localPart: string;
  /** Domain as written (after trim), before punycode conversion. */
  domainRaw: string;
  /** ASCII/punycode domain, lowercased — the form used for DNS. */
  domain: string;
  /** Normalized address: localPart (unchanged) + "@" + ASCII domain. */
  email: string;
  /** True when the local part contains non-ASCII and needs SMTPUTF8. */
  requiresSmtpUtf8: boolean;
  /** True when the domain as written contained non-ASCII. */
  domainWasInternationalized: boolean;
  /**
   * Deduplication key. Mailbox names are technically case-sensitive, but
   * in practice providers treat them case-insensitively; bulk dedup
   * (PRD §9.1: duplicate rows are not charged twice) therefore uses the
   * fully lowercased normalized address. The display/stored normalized
   * address above keeps the original local-part case.
   */
  dedupKey: string;
}

export type EmailParseResult =
  | { ok: true; value: NormalizedEmail }
  | { ok: false; message: string };

const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const NON_ASCII = /[^\u0000-\u007f]/;
// RFC 5322 atext for dot-atom local parts.
const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;

function fail(message: string): EmailParseResult {
  return { ok: false, message };
}

function validateDotAtomLocal(local: string): string | null {
  if (local.length === 0) return "local part is empty";
  if (local.startsWith(".") || local.endsWith(".")) return "local part starts or ends with a dot";
  if (local.includes("..")) return "local part contains consecutive dots";
  for (const segment of local.split(".")) {
    if (!ATEXT.test(segment) && !NON_ASCII.test(segment)) {
      return `local part segment contains disallowed characters: ${segment}`;
    }
    // Pure-ASCII segments must be strict atext; non-ASCII segments are
    // accepted structurally and flagged via requiresSmtpUtf8 instead of
    // being silently altered (PRD §4.5 Stage 1).
    if (!NON_ASCII.test(segment) && !ATEXT.test(segment)) {
      return `local part segment contains disallowed characters: ${segment}`;
    }
    if (NON_ASCII.test(segment)) {
      // Still reject ASCII punctuation that is never valid unquoted.
      if (/["(),:;<>@[\\\] ]/.test(segment)) return "local part contains disallowed characters";
    }
  }
  return null;
}

function validateQuotedLocal(local: string): string | null {
  if (local.length < 2 || !local.startsWith('"') || !local.endsWith('"')) {
    return "quoted local part is malformed";
  }
  const inner = local.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "\\") {
      i++; // escaped char — skip the next character
      if (i >= inner.length) return "quoted local part ends with a dangling escape";
      continue;
    }
    if (ch === '"') return "quoted local part contains an unescaped quote";
    if (CONTROL_OR_SPACE.test(ch) && ch !== " ") return "quoted local part contains a control character";
  }
  return null;
}

export function parseEmail(input: unknown): EmailParseResult {
  if (typeof input !== "string") return fail("email must be a string");
  const original = input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return fail("email is empty");
  // Reject CRLF / header injection and any embedded whitespace or control
  // characters anywhere in the trimmed value. (A quoted local part may
  // legitimately contain a space, handled below by re-checking segments.)
  const isQuoted = trimmed.startsWith('"');
  if (!isQuoted && CONTROL_OR_SPACE.test(trimmed)) {
    return fail("email contains whitespace or control characters");
  }
  if (/[\r\n]/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return fail("email contains control characters or CRLF");
  }

  // Split at the LAST '@': a quoted local part may contain '@', an
  // unquoted one may not (that case is caught by the segment checks).
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return fail("email has no @ separator");
  const localPart = trimmed.slice(0, at);
  const domainRaw = trimmed.slice(at + 1);

  if (localPart.length === 0) return fail("local part is empty");
  if (domainRaw.length === 0) return fail("domain is empty");
  if (localPart.length > 64) return fail("local part exceeds 64 characters");

  const localError = localPart.startsWith('"')
    ? validateQuotedLocal(localPart)
    : validateDotAtomLocal(localPart);
  if (localError) return fail(localError);
  if (isQuoted && CONTROL_OR_SPACE.test(localPart.slice(1, -1).replace(/\\ /g, "")) && /[\t]/.test(localPart)) {
    return fail("local part contains a tab character");
  }

  // --- Domain -------------------------------------------------------------
  if (domainRaw.includes("_")) return fail("domain contains an underscore");
  if (domainRaw.startsWith(".") || domainRaw.endsWith(".")) return fail("domain starts or ends with a dot");
  if (domainRaw.startsWith("[") || domainRaw.endsWith("]")) {
    return fail("address literals are not accepted as email domains");
  }
  const domainLower = domainRaw.toLowerCase();
  const domainWasInternationalized = NON_ASCII.test(domainLower);
  const domain = domainToASCII(domainLower);
  if (!domain) return fail("domain cannot be converted to ASCII/punycode");
  if (domain.length > 253) return fail("domain exceeds 253 characters");
  const labels = domain.split(".");
  if (labels.length < 2) return fail("domain must contain at least one dot");
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return fail("domain label length must be 1-63 characters");
    if (!/^[a-z0-9-]+$/.test(label)) return fail(`domain label contains disallowed characters: ${label}`);
    if (label.startsWith("-") || label.endsWith("-")) return fail("domain label starts or ends with a hyphen");
  }
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2) return fail("top-level domain is too short");
  if (/^\d+$/.test(tld)) return fail("top-level domain must not be all numeric");

  const email = `${localPart}@${domain}`;
  if (email.length > 254) return fail("email exceeds 254 characters");

  const requiresSmtpUtf8 = NON_ASCII.test(localPart);
  return {
    ok: true,
    value: {
      original,
      trimmed,
      localPart,
      domainRaw,
      domain,
      email,
      requiresSmtpUtf8,
      domainWasInternationalized,
      dedupKey: `${localPart.toLowerCase()}@${domain}`,
    },
  };
}

/** Convenience wrapper for callers that prefer exceptions. */
export function normalizeEmail(input: unknown): NormalizedEmail {
  const result = parseEmail(input);
  if (!result.ok) throw new Error(`Invalid email syntax: ${result.message}`);
  return result.value;
}

/** Dedup key for a raw input, or null when the input does not parse. */
export function dedupKeyFor(input: unknown): string | null {
  const result = parseEmail(input);
  return result.ok ? result.value.dedupKey : null;
}
