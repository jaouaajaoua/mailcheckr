import { describe, it, expect } from "vitest";
import { escapeCsvCell, escapeCsvRow, buildCsv } from "../src/csv";
import { isChargeableResult, decideBatchCharges, countChargeable } from "../src/credits";

describe("escapeCsvCell — formula injection prevention (PRD §10.4)", () => {
  it("neutralizes leading =, +, -, @", () => {
    expect(escapeCsvCell("=2+5")).toBe("'=2+5");
    expect(escapeCsvCell("+2+5")).toBe("'+2+5");
    expect(escapeCsvCell("-2+5")).toBe("'-2+5");
    expect(escapeCsvCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
  });
  it("neutralizes formula leads hidden behind whitespace/tab", () => {
    expect(escapeCsvCell("  =cmd")).toBe("'  =cmd");
    expect(escapeCsvCell("\t=cmd")).toBe("'\t=cmd");
  });
  it("leaves ordinary cells untouched", () => {
    expect(escapeCsvCell("person@example.com")).toBe("person@example.com");
    expect(escapeCsvCell("likely_valid")).toBe("likely_valid");
    expect(escapeCsvCell("a-b")).toBe("a-b");
    expect(escapeCsvCell(42)).toBe("42");
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });
  it("applies RFC 4180 quoting for commas, quotes and newlines", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("formula neutralization happens before quoting", () => {
    expect(escapeCsvCell("=a,b")).toBe('"\'=a,b"');
  });
  it("escapeCsvRow and buildCsv compose correctly", () => {
    expect(escapeCsvRow(["email", "status"])).toBe("email,status");
    expect(buildCsv([["email", "note"], ["a@b.co", "=evil"]])).toBe("email,note\r\na@b.co,'=evil\r\n");
  });
});

describe("credit helpers (PRD §9.1)", () => {
  it("unknown outcomes are never chargeable", () => {
    expect(isChargeableResult("unknown", ["smtp_greylisted"])).toBe(false);
    expect(isChargeableResult("unknown", ["dns_temporary_failure"])).toBe(false);
  });
  it("parsing failures are never chargeable", () => {
    expect(isChargeableResult("invalid", ["syntax_invalid"])).toBe(false);
  });
  it("completed conclusive results are chargeable", () => {
    expect(isChargeableResult("valid", ["smtp_mailbox_accepted"])).toBe(true);
    expect(isChargeableResult("likely_valid", ["smtp_not_attempted_quick_mode"])).toBe(true);
    expect(isChargeableResult("risky", ["disposable_domain"])).toBe(true);
    expect(isChargeableResult("invalid", ["domain_nxdomain"])).toBe(true);
    expect(isChargeableResult("invalid", ["smtp_mailbox_rejected_definitive"])).toBe(true);
  });
  it("duplicate rows (by normalized dedup key) are never charged twice", () => {
    const decisions = decideBatchCharges([
      { email: "Person@Example.com", status: "likely_valid", reasonCodes: ["smtp_not_attempted_quick_mode"] },
      { email: "person@example.com", status: "likely_valid", reasonCodes: ["smtp_not_attempted_quick_mode"] },
      { email: "other@example.com", status: "likely_valid", reasonCodes: ["smtp_not_attempted_quick_mode"] },
    ]);
    expect(decisions.map((d) => d.isDuplicate)).toEqual([false, true, false]);
    expect(decisions.map((d) => d.chargeable)).toEqual([true, false, true]);
    expect(countChargeable([
      { email: "Person@Example.com", status: "likely_valid", reasonCodes: ["smtp_not_attempted_quick_mode"] },
      { email: "person@example.com", status: "likely_valid", reasonCodes: ["smtp_not_attempted_quick_mode"] },
    ])).toBe(1);
  });
  it("a batch of unknowns and syntax failures charges zero", () => {
    expect(countChargeable([
      { email: "a@example.com", status: "unknown", reasonCodes: ["smtp_connection_timeout"] },
      { email: "broken", status: "invalid", reasonCodes: ["syntax_invalid"] },
    ])).toBe(0);
  });
});
