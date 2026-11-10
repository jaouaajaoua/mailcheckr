import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module";
import { VerificationService } from "../src/verification/verification.service";
import { REPOSITORY, type Repository } from "../src/repositories/repository";
import type { InMemoryRepository } from "../src/repositories/in-memory.repository";
import { fakeDns, OK_MX } from "./helpers";

/**
 * Web <-> API contract reconciliation: the dashboard (apps/web/lib/api.ts)
 * calls /v1/auth/*, GET /v1/batches, GET /v1/verifications, GET /v1/auth/me,
 * GET /v1/account/settings and DELETE /v1/account. These tests pin those
 * routes to the backend so the two sides cannot drift apart again.
 */
async function buildApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VerificationService)
    .useValue(new VerificationService(fakeDns({ "example.com": OK_MX, "gmail.com": OK_MX })))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await (app as any).getHttpAdapter().getInstance().ready();
  return { app, repo: moduleRef.get(REPOSITORY) as Repository & InMemoryRepository };
}
const inject = (app: NestFastifyApplication, opts: any) => (app as any).getHttpAdapter().getInstance().inject(opts);
const register = async (app: NestFastifyApplication, email: string) => {
  const res = await inject(app, { method: "POST", url: "/v1/auth/register", payload: { email, password: "password-12345" } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
};

describe("Reconciliation: versioned auth + web-called endpoints", () => {
  let app: NestFastifyApplication;
  let repo: Repository & InMemoryRepository;
  let tokenA = ""; let tokenB = ""; let userA: any; let batchId1 = ""; let batchId2 = "";
  beforeAll(async () => { ({ app, repo } = await buildApp()); });
  afterAll(async () => { await app.close(); });

  it("auth lives under /v1/auth (old unversioned path is gone) and returns access_token + user.workspace_id", async () => {
    const body = await register(app, "a@example.com");
    tokenA = body.access_token;
    userA = body.user;
    expect(tokenA).toBeTruthy();
    expect(body.accessToken).toBe(tokenA); // legacy alias retained for existing API consumers
    expect(userA.workspace_id).toBeTruthy();
    const old = await inject(app, { method: "POST", url: "/auth/register", payload: { email: "x@example.com", password: "password-12345" } });
    expect(old.statusCode).toBe(404);
    const regB = await register(app, "b@example.com");
    tokenB = regB.access_token;
  });

  it("GET /v1/auth/me returns the current user + workspace; unauthenticated is 401", async () => {
    const res = await inject(app, { method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const me = JSON.parse(res.body);
    expect(me.id).toBe(userA.id);
    expect(me.email).toBe("a@example.com");
    expect(me.workspace_id).toBe(userA.workspace_id);
    expect(me.created_at).toBeTruthy();
    const anon = await inject(app, { method: "GET", url: "/v1/auth/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("GET /v1/verifications lists persisted single checks, newest first, tenant-isolated", async () => {
    for (const email of ["first@example.com", "second@example.com"]) {
      const res = await inject(app, { method: "POST", url: "/v1/verifications", headers: { authorization: `Bearer ${tokenA}` }, payload: { email, mode: "quick" } });
      expect(res.statusCode).toBe(201);
    }
    const res = await inject(app, { method: "GET", url: "/v1/verifications?limit=10", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).data;
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.email)).toEqual(["second@example.com", "first@example.com"]);
    expect(items[0].status).toBe("likely_valid");
    expect(items[0].confidence).toBeTruthy();
    expect(items[0].checked_at).toBeTruthy();
    // Tenant isolation: workspace B has no single checks.
    const other = await inject(app, { method: "GET", url: "/v1/verifications?limit=10", headers: { authorization: `Bearer ${tokenB}` } });
    expect(JSON.parse(other.body).data).toEqual([]);
    const anon = await inject(app, { method: "GET", url: "/v1/verifications" });
    expect(anon.statusCode).toBe(401);
  });

  it("GET /v1/batches lists the workspace's batches newest first with summary fields, tenant-isolated", async () => {
    const mk = async (name: string, emails: string[]) => {
      const res = await inject(app, { method: "POST", url: "/v1/batches", headers: { authorization: `Bearer ${tokenA}` }, payload: { name, emails, mode: "quick" } });
      expect(res.statusCode).toBe(201);
      return JSON.parse(res.body);
    };
    const b1 = await mk("November contacts", ["one@example.com", "one@example.com"]);
    const b2 = await mk("December contacts", ["two@example.com"]);
    batchId1 = b1.id; batchId2 = b2.id;
    expect(b1.name).toBe("November contacts");
    const res = await inject(app, { method: "GET", url: "/v1/batches?limit=50", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).data;
    expect(items.map((b: any) => b.id)).toEqual([batchId2, batchId1]); // newest first
    const first = items[1];
    expect(first.name).toBe("November contacts");
    expect(first.status).toBe("completed");
    expect(first.mode).toBe("quick");
    expect(first.row_count).toBe(2);
    expect(first.unique_count).toBe(1);
    expect(first.duplicate_count).toBe(1);
    expect(first.completed_count).toBe(1);
    expect(first.credits_charged).toBe(1);
    expect(first.created_at).toBeTruthy();
    // Tenant isolation: workspace B's list is empty and never leaks A's rows.
    const other = await inject(app, { method: "GET", url: "/v1/batches?limit=50", headers: { authorization: `Bearer ${tokenB}` } });
    expect(JSON.parse(other.body).data).toEqual([]);
  });

  it("GET /v1/usage exposes the documented field names (plan_code, credits_reserved, checks_this_month)", async () => {
    const res = await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const u = JSON.parse(res.body);
    expect(u.plan_code).toBe("free");
    expect(typeof u.credits_reserved).toBe("number");
    expect(u.checks_total).toBe(4); // 2 single checks + 2 batch records
    expect(u.checks_this_month).toBe(4);
    expect(u.period_start).toBeTruthy();
    expect(u.period_end).toBeTruthy();
  });

  it("GET /v1/account/settings returns live retention, plan and credits summary; unauthenticated is 401", async () => {
    const res = await inject(app, { method: "GET", url: "/v1/account/settings", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const s = JSON.parse(res.body);
    expect(s.workspace_id).toBe(userA.workspace_id);
    expect(s.plan_code).toBe("free");
    expect(s.source_retention_hours).toBe(24);
    expect(s.result_retention_days).toBe(7);
    // Credits reconcile with the ledger: 100 granted - 2 single - 2 batch charges.
    expect(s.credits_balance).toBe(96);
    expect(s.credits_charged).toBe(4);
    expect(s.checks_total).toBe(4);
    const anon = await inject(app, { method: "GET", url: "/v1/account/settings" });
    expect(anon.statusCode).toBe(401);
  });

  it("DELETE /v1/account rejects a wrong confirmation and API-key auth, then actually purges", async () => {
    // Give A an API key so its removal is observable.
    const keyRes = await inject(app, { method: "POST", url: "/v1/api-keys", headers: { authorization: `Bearer ${tokenA}` }, payload: { name: "doomed" } });
    const key = JSON.parse(keyRes.body);
    expect(key.secret).toBeTruthy();

    const wrong = await inject(app, { method: "DELETE", url: "/v1/account", headers: { authorization: `Bearer ${tokenA}` }, payload: { confirmation: "delete" } });
    expect(wrong.statusCode).toBe(422);
    // Account still intact after the rejected attempt.
    expect((await inject(app, { method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${tokenA}` } })).statusCode).toBe(200);

    const viaKey = await inject(app, { method: "DELETE", url: "/v1/account", headers: { authorization: `Bearer ${key.secret}` }, payload: { confirmation: "DELETE" } });
    expect(viaKey.statusCode).toBe(403);

    const ledgerBefore = [...repo.ledger.values()].filter((e) => e.workspaceId === userA.workspace_id);
    expect(ledgerBefore.length).toBeGreaterThan(0);
    const totalAmount = ledgerBefore.reduce((s, e) => s + e.quantity, 0);

    const del = await inject(app, { method: "DELETE", url: "/v1/account", headers: { authorization: `Bearer ${tokenA}` }, payload: { confirmation: "DELETE" } });
    expect(del.statusCode).toBe(200);
    const result = JSON.parse(del.body);
    expect(result.status).toBe("deleted");
    expect(result.batches_removed).toBe(2);
    expect(result.records_removed).toBe(4);
    expect(result.api_keys_removed).toBe(1);
    expect(result.ledger_entries_retained).toBe(ledgerBefore.length);

    // Data is actually gone at the repository level.
    expect(await repo.findUserById(userA.id)).toBeNull();
    expect(await repo.findWorkspaceById(userA.workspace_id)).toBeNull();
    expect(await repo.listBatches(userA.workspace_id, { limit: 50 })).toEqual([]);
    expect(await repo.listRecentRecords(userA.workspace_id, { limit: 50 })).toEqual([]);
    expect(await repo.listApiKeys(userA.workspace_id)).toEqual([]);
    // Ledger retained with amounts intact, personal links severed.
    const ledgerAfter = [...repo.ledger.values()].filter((e) => e.workspaceId === userA.workspace_id);
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(ledgerAfter.reduce((s, e) => s + e.quantity, 0)).toBe(totalAmount);
    expect(ledgerAfter.every((e) => e.batchId === null && e.verificationRecordId === null)).toBe(true);
    // An audit event records the deletion.
    expect(repo.audits.some((a) => a.action === "account.delete" && a.actorId === userA.id)).toBe(true);
    // The old session and API key no longer authenticate; login is impossible.
    expect((await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${tokenA}` } })).statusCode).toBe(401);
    expect((await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key.secret}` } })).statusCode).toBe(401);
    expect((await inject(app, { method: "POST", url: "/v1/auth/login", payload: { email: "a@example.com", password: "password-12345" } })).statusCode).toBe(401);
    // Workspace B is untouched.
    expect((await inject(app, { method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${tokenB}` } })).statusCode).toBe(200);
  });

  it("DELETE /v1/account with no body (the dashboard's exact request) also purges", async () => {
    const reg = await register(app, "c@example.com");
    const del = await inject(app, { method: "DELETE", url: "/v1/account", headers: { authorization: `Bearer ${reg.access_token}` } });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).status).toBe("deleted");
    expect(await repo.findUserByEmail("c@example.com")).toBeNull();
  });
});
