import { describe, it, expect } from "vitest";
import { InMemoryRepository } from "../src/repositories/in-memory.repository";
import { AuthService } from "../src/auth/auth.service";
import { testConfig } from "./helpers";

describe("AuthService", () => {
  it("register creates user + workspace + 100 free credits, login works", async () => {
    const repo = new InMemoryRepository();
    const auth = new AuthService(repo, testConfig);
    const reg = await auth.register("Person@Example.COM", "correct horse battery", "Person");
    expect(reg.user.email).toBe("Person@example.com");
    expect(reg.accessToken.split(".")).toHaveLength(3);
    expect(await repo.sumLedger(reg.workspace.id)).toBe(100);
    const login = await auth.login("Person@example.com", "correct horse battery");
    expect(login.workspace.id).toBe(reg.workspace.id);
    // password is stored hashed, never plaintext
    const stored = await repo.findUserByEmail("Person@example.com");
    expect(stored?.passwordHash).not.toContain("correct horse");
    expect(stored?.passwordHash?.startsWith("$2")).toBe(true);
  });
  it("login rejects wrong password with generic error; duplicate register conflicts", async () => {
    const repo = new InMemoryRepository();
    const auth = new AuthService(repo, testConfig);
    await auth.register("a@example.com", "password-ten-chars");
    await expect(auth.login("a@example.com", "wrong-password")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(auth.register("a@example.com", "password-ten-chars")).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
  });
  it("password reset: token stored hashed, confirm changes password, token single-use", async () => {
    const repo = new InMemoryRepository();
    const auth = new AuthService(repo, testConfig);
    await auth.register("b@example.com", "old-password-123");
    const req = await auth.requestPasswordReset("b@example.com");
    expect(req.devResetToken).toBeTruthy();
    // stored token is a hash, not the plaintext token
    const stored = [...repo.resetTokens.values()][0];
    expect(stored.tokenHash).not.toBe(req.devResetToken);
    await auth.confirmPasswordReset(req.devResetToken!, "new-password-456");
    await expect(auth.login("b@example.com", "old-password-123")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await auth.login("b@example.com", "new-password-456");
    await expect(auth.confirmPasswordReset(req.devResetToken!, "another-password-1")).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
  });
  it("reset request for unknown email returns generic ok (no enumeration, no token)", async () => {
    const repo = new InMemoryRepository();
    const auth = new AuthService(repo, testConfig);
    const res = await auth.requestPasswordReset("nobody@example.com");
    expect(res).toEqual({ ok: true });
  });
});
