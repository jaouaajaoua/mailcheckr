import { describe, it, expect } from "vitest";
import {
  isDisposableDomain,
  isFreeProviderDomain,
  getRolePrefix,
  DATASET_METADATA,
  DISPOSABLE_DOMAINS,
} from "./index";

describe("seed datasets", () => {
  it("recognizes well-known disposable domains, case/punycode-insensitively", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("GuerrillaMail.com")).toBe(true);
    expect(isDisposableDomain("10minutemail.com")).toBe(true);
    expect(isDisposableDomain("example.com")).toBe(false);
    expect(DISPOSABLE_DOMAINS.size).toBeGreaterThanOrEqual(28);
  });
  it("recognizes free providers as metadata only", () => {
    expect(isFreeProviderDomain("gmail.com")).toBe(true);
    expect(isFreeProviderDomain("outlook.com")).toBe(true);
    expect(isFreeProviderDomain("example.com")).toBe(false);
  });
  it("detects role prefixes whole and segmented", () => {
    expect(getRolePrefix("support")).toBe("support");
    expect(getRolePrefix("Sales-EU")).toBe("sales");
    expect(getRolePrefix("jane.doe")).toBeNull();
  });
  it("every dataset carries source/license/version/importedAt/hash metadata", () => {
    for (const m of DATASET_METADATA) {
      expect(m.source).toContain("curated in-repo");
      expect(m.license).toBe("curated in-repo, public facts");
      expect(m.version).toBeTruthy();
      expect(m.importedAt).toBeTruthy();
      expect(m.hash).toBeTruthy();
      expect(m.description).toContain("SEED");
    }
  });
});
