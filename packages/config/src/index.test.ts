import { describe, it, expect } from "vitest";
import { loadConfig, isDeepSmtpEnabled } from "./index";

const base = {
  JWT_SECRET: "x".repeat(40),
  ENCRYPTION_KEY: "y".repeat(40),
  HMAC_KEY: "z".repeat(40),
};

describe("config loader", () => {
  it("applies defaults: deep gate off, ports, retention", () => {
    const c = loadConfig(base);
    expect(c.SMTP_DEEP_ENABLED).toBe(false);
    expect(c.SMTP_EGRESS_APPROVED).toBe(false);
    expect(c.API_PORT).toBe(4000);
    expect(c.RESULT_RETENTION_DAYS).toBe(7);
    expect(c.FREE_CREDITS_GRANT).toBe(100);
    expect(c.RETENTION_DAYS).toBe(7);
  });
  it("rejects short secrets", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });
  it("parses string booleans and numbers", () => {
    const c = loadConfig({ ...base, SMTP_DEEP_ENABLED: "true", API_PORT: "8080" });
    expect(c.SMTP_DEEP_ENABLED).toBe(true);
    expect(c.API_PORT).toBe(8080);
  });
});

describe("isDeepSmtpEnabled gate (PRD §6)", () => {
  it("false when both flags false", () => {
    expect(isDeepSmtpEnabled(loadConfig(base))).toBe(false);
  });
  it("false when only operator flag true (no provider approval)", () => {
    expect(isDeepSmtpEnabled(loadConfig({ ...base, SMTP_DEEP_ENABLED: "true" }))).toBe(false);
  });
  it("false when only approval flag true", () => {
    expect(isDeepSmtpEnabled(loadConfig({ ...base, SMTP_EGRESS_APPROVED: "true" }))).toBe(false);
  });
  it("true only when BOTH flags true", () => {
    expect(isDeepSmtpEnabled(loadConfig({ ...base, SMTP_DEEP_ENABLED: "true", SMTP_EGRESS_APPROVED: "true" }))).toBe(true);
  });
});
