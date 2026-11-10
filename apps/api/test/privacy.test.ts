import { describe, it, expect } from "vitest";
import { encryptValue, decryptValue, hmacDigest } from "../src/common/crypto";
import { redactForLog, redactString } from "../src/common/redact";

describe("AES-256-GCM email encryption (PRD §10.1)", () => {
  const KEY = "test-encryption-key-at-least-32-chars";
  it("round-trips and ciphertext does not contain the plaintext email", () => {
    const ct = encryptValue("person@example.com", KEY);
    expect(ct).not.toContain("person@example.com");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(decryptValue(ct, KEY)).toBe("person@example.com");
  });
  it("each encryption uses a fresh IV (ciphertexts differ)", () => {
    expect(encryptValue("a@example.com", KEY)).not.toBe(encryptValue("a@example.com", KEY));
  });
  it("tampered ciphertext fails authentication", () => {
    const ct = encryptValue("a@example.com", KEY);
    const parts = ct.split(":"); parts[3] = Buffer.from("tampered-value-here").toString("base64url");
    expect(() => decryptValue(parts.join(":"), KEY)).toThrow();
  });
  it("email HMAC digest is deterministic, keyed, and not a plain hash", () => {
    const d1 = hmacDigest("a@example.com", "key-one-at-least-32-characters-long");
    const d2 = hmacDigest("a@example.com", "key-one-at-least-32-characters-long");
    const d3 = hmacDigest("a@example.com", "key-two-at-least-32-characters-long");
    expect(d1).toBe(d2); expect(d1).not.toBe(d3);
    expect(d1).not.toContain("a@example.com");
  });
});

describe("log redaction (PRD §12)", () => {
  it("masks emails, API keys, and sensitive fields; keeps safe fields", () => {
    const out: any = redactForLog({
      msg: "checked person@example.com with mc_live_abcdefgh12345678",
      password: "hunter2", nested: { apiKey: "mc_live_xyz", email: "a@b.co", count: 3 },
      list: ["two@example.com"],
    });
    expect(out.msg).not.toContain("person@example.com");
    expect(out.msg).toContain("p***@example.com");
    expect(out.msg).not.toContain("mc_live_abcdefgh12345678");
    expect(out.password).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested.email).toBe("a***@b.co");
    expect(out.nested.count).toBe(3);
    expect(out.list[0]).toBe("t***@example.com");
  });
  it("redactString leaves non-sensitive text unchanged", () => {
    expect(redactString("batch completed: 42 rows")).toBe("batch completed: 42 rows");
  });
});
