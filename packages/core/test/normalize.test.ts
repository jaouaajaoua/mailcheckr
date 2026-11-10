import { describe, it, expect } from "vitest";
import { parseEmail, normalizeEmail, dedupKeyFor } from "../src/normalize";

describe("parseEmail — valid normalization", () => {
  it("trims outer whitespace and preserves the original", () => {
    const r = parseEmail("  person@example.com  ");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.original).toBe("  person@example.com  ");
      expect(r.value.email).toBe("person@example.com");
    }
  });
  it("lowercases the domain only, never the local part", () => {
    const r = parseEmail("Jane.Doe@EXAMPLE.COM");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.localPart).toBe("Jane.Doe");
      expect(r.value.domain).toBe("example.com");
      expect(r.value.email).toBe("Jane.Doe@example.com");
    }
  });
  it("converts internationalized domains to punycode", () => {
    const r = parseEmail("user@münchen.de");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.domain).toBe("xn--mnchen-3ya.de");
      expect(r.value.domainWasInternationalized).toBe(true);
      expect(r.value.email).toBe("user@xn--mnchen-3ya.de");
    }
    const r2 = parseEmail("user@bücher.de");
    expect(r2.ok && r2.value.domain).toBe("xn--bcher-kva.de");
  });
  it("flags a non-ASCII local part as requiring SMTPUTF8 without altering it", () => {
    const r = parseEmail("üser@example.com");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.requiresSmtpUtf8).toBe(true);
      expect(r.value.localPart).toBe("üser");
    }
  });
  it("accepts a quoted local part containing a space", () => {
    const r = parseEmail('"john doe"@example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.localPart).toBe('"john doe"');
  });
  it("accepts plus addressing and subdomains", () => {
    expect(parseEmail("jane+news@mail.example.co.uk").ok).toBe(true);
  });
  it("produces a case-insensitive dedup key while preserving display case", () => {
    expect(dedupKeyFor("User@EXAMPLE.com")).toBe("user@example.com");
    expect(dedupKeyFor("user@example.com")).toBe(dedupKeyFor("USER@Example.COM"));
    expect(normalizeEmail("User@EXAMPLE.com").email).toBe("User@example.com");
  });
});

describe("parseEmail — syntax rejection", () => {
  const invalid: Array<[string, unknown]> = [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
    ["missing @", "person.example.com"],
    ["double @ in unquoted local", "a@b@example.com"],
    ["empty local", "@example.com"],
    ["empty domain", "person@"],
    ["embedded space", "per son@example.com"],
    ["embedded tab", "per\tson@example.com"],
    ["CRLF injection", "person@example.com\r\nBcc: victim@example.com"],
    ["control character", "person@example.com"],
    ["local leading dot", ".person@example.com"],
    ["local trailing dot", "person.@example.com"],
    ["local consecutive dots", "per..son@example.com"],
    [" local disallowed char", "per(son@example.com"],
    ["domain underscore", "person@exa_mple.com"],
    ["domain single label", "person@localhost"],
    ["domain leading dot", "person@.example.com"],
    ["domain trailing dot", "person@example.com."],
    ["domain label leading hyphen", "person@-example.com"],
    ["domain all-numeric TLD", "person@example.123"],
    ["one-char TLD", "person@example.c"],
    ["address literal domain", "person@[127.0.0.1]"],
    ["local part too long (65 chars)", `${"a".repeat(65)}@example.com`],
    ["domain label too long (64 chars)", `person@${"a".repeat(64)}.com`],
    ["unterminated quoted local", '"john doe@example.com'],
  ];
  for (const [name, input] of invalid) {
    it(`rejects: ${name}`, () => {
      expect(parseEmail(input).ok).toBe(false);
    });
  }
  it("rejects an address longer than 254 characters overall", () => {
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(long.length).toBeGreaterThan(254);
    expect(parseEmail(long).ok).toBe(false);
  });
});
