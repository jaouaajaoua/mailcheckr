import { describe, it, expect } from "vitest";
import { InMemoryRepository } from "../src/repositories/in-memory.repository";
import { ApiKeysService } from "../src/api-keys/api-keys.service";
import { testConfig } from "./helpers";

describe("ApiKeysService (PRD §8.1)", () => {
  it("secret shown once at creation; only HMAC hash + prefix stored", async () => {
    const repo = new InMemoryRepository();
    const keys = new ApiKeysService(repo, testConfig);
    const created = await keys.create("ws1", "CI key");
    expect(created.secret.startsWith("mc_live_")).toBe(true);
    const stored = [...repo.apiKeys.values()][0];
    expect(stored.keyHash).not.toBe(created.secret);
    expect(stored.keyHash).not.toContain(created.secret);
    expect(stored.keyPrefix).toBe(created.secret.slice(0, 16));
    expect(JSON.stringify(await keys.list("ws1"))).not.toContain(created.secret);
  });
  it("authenticate accepts the secret, updates last_used_at; revoke blocks it", async () => {
    const repo = new InMemoryRepository();
    const keys = new ApiKeysService(repo, testConfig);
    const created = await keys.create("ws1", "CI key");
    const authed = await keys.authenticate(created.secret);
    expect(authed?.id).toBe(created.id);
    expect(authed?.lastUsedAt).toBeTruthy();
    expect(await keys.authenticate("mc_live_wrongsecretwrongsecretwrongse")).toBeNull();
    await keys.revoke("ws1", created.id);
    expect(await keys.authenticate(created.secret)).toBeNull();
  });
  it("revoke is tenant-scoped: another workspace cannot revoke", async () => {
    const repo = new InMemoryRepository();
    const keys = new ApiKeysService(repo, testConfig);
    const created = await keys.create("ws1", "CI key");
    await expect(keys.revoke("ws2", created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await keys.authenticate(created.secret)).not.toBeNull();
  });
});
