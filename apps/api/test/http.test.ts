import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module";
import { VerificationService } from "../src/verification/verification.service";
import { RATE_LIMITER, RateLimiter } from "../src/common/rate-limit";
import { fakeDns, OK_MX } from "./helpers";

async function buildApp(limiter?: RateLimiter) {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VerificationService)
    .useValue(new VerificationService(fakeDns({ "example.com": OK_MX, "gmail.com": OK_MX })));
  if (limiter) builder = builder.overrideProvider(RATE_LIMITER).useValue(limiter);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await (app as any).getHttpAdapter().getInstance().ready();
  return app;
}
const inject = (app: NestFastifyApplication, opts: any) => (app as any).getHttpAdapter().getInstance().inject(opts);

describe("HTTP API (Nest + Fastify, in-memory repo)", () => {
  let app: NestFastifyApplication;
  let tokenA = ""; let tokenB = ""; let batchId = "";
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("register → 201 with token + workspace; error envelope shape on bad login", async () => {
    const res = await inject(app, { method: "POST", url: "/v1/auth/register", payload: { email: "a@example.com", password: "password-12345" } });
    expect(res.statusCode).toBe(201);
    tokenA = JSON.parse(res.body).accessToken;
    expect(tokenA).toBeTruthy();
    const bad = await inject(app, { method: "POST", url: "/v1/auth/login", payload: { email: "a@example.com", password: "wrong-password" } });
    expect(bad.statusCode).toBe(401);
    const env = JSON.parse(bad.body);
    expect(env.error.code).toBe("INVALID_CREDENTIALS");
    expect(env.error.request_id).toMatch(/^req_/);
    const regB = await inject(app, { method: "POST", url: "/v1/auth/register", payload: { email: "b@example.com", password: "password-12345" } });
    tokenB = JSON.parse(regB.body).accessToken;
  });

  it("single quick verification: likely_valid, charged 1 credit (100 → 99)", async () => {
    const res = await inject(app, { method: "POST", url: "/v1/verifications", headers: { authorization: `Bearer ${tokenA}` }, payload: { email: "person@example.com", mode: "quick" } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("likely_valid");
    expect(body.reason_codes).toContain("smtp_not_attempted_quick_mode");
    const usage = await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${tokenA}` } });
    expect(JSON.parse(usage.body).credits_balance).toBe(99);
  });

  it("deep mode with gate off: smtp_port_unavailable, never valid", async () => {
    const res = await inject(app, { method: "POST", url: "/v1/verifications", headers: { authorization: `Bearer ${tokenA}` }, payload: { email: "person@example.com", mode: "deep" } });
    const body = JSON.parse(res.body);
    expect(body.status).not.toBe("valid");
    expect(body.reason_codes).toContain("smtp_port_unavailable");
  });

  it("API key flow: create shows secret once, key authenticates, revoke blocks", async () => {
    const created = await inject(app, { method: "POST", url: "/v1/api-keys", headers: { authorization: `Bearer ${tokenA}` }, payload: { name: "ci" } });
    expect(created.statusCode).toBe(201);
    const key = JSON.parse(created.body);
    expect(key.secret.startsWith("mc_live_")).toBe(true);
    const list = await inject(app, { method: "GET", url: "/v1/api-keys", headers: { authorization: `Bearer ${tokenA}` } });
    expect(list.body).not.toContain(key.secret);
    const viaKey = await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key.secret}` } });
    expect(viaKey.statusCode).toBe(200);
    await inject(app, { method: "DELETE", url: `/v1/api-keys/${key.id}`, headers: { authorization: `Bearer ${tokenA}` } });
    const after = await inject(app, { method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key.secret}` } });
    expect(after.statusCode).toBe(401);
  });

  it("batch: dedupe, duplicates not charged, results + export + usage reconcile", async () => {
    const res = await inject(app, { method: "POST", url: "/v1/batches", headers: { authorization: `Bearer ${tokenA}` }, payload: { emails: ["one@example.com", "two@example.com", "one@example.com", "bad-syntax"], mode: "quick" } });
    expect(res.statusCode).toBe(201);
    const batch = JSON.parse(res.body);
    batchId = batch.id;
    expect(batch.status).toBe("completed");
    expect(batch.row_count).toBe(4);
    expect(batch.unique_count).toBe(3);
    expect(batch.duplicate_count).toBe(1);
    expect(batch.credits_charged).toBe(3); // 2 likely_valid + 1 invalid; duplicate free
    const results = await inject(app, { method: "GET", url: `/v1/batches/${batchId}/results`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(JSON.parse(results.body).items).toHaveLength(3);
    const exp = await inject(app, { method: "POST", url: `/v1/batches/${batchId}/export`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(exp.statusCode).toBe(201);
    expect(exp.body).toContain("duplicate");
    expect(exp.body).toContain("one@example.com");
    const ledger = await inject(app, { method: "GET", url: "/v1/credits/ledger", headers: { authorization: `Bearer ${tokenA}` } });
    expect(JSON.parse(ledger.body).items.length).toBeGreaterThan(0);
  });

  it("TENANT ISOLATION: workspace B cannot read, export, cancel, or delete workspace A's batch", async () => {
    for (const [method, url] of [["GET", `/v1/batches/${batchId}`], ["GET", `/v1/batches/${batchId}/results`], ["POST", `/v1/batches/${batchId}/export`], ["POST", `/v1/batches/${batchId}/cancel`], ["DELETE", `/v1/batches/${batchId}`]] as const) {
      const res = await inject(app, { method, url, headers: { authorization: `Bearer ${tokenB}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // A's batch still intact
    const mine = await inject(app, { method: "GET", url: `/v1/batches/${batchId}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(mine.statusCode).toBe(200);
  });

  it("DELETE batch verifiably purges: afterwards batch + results are 404", async () => {
    const created = await inject(app, { method: "POST", url: "/v1/batches", headers: { authorization: `Bearer ${tokenA}` }, payload: { emails: ["gone@example.com"], mode: "quick" } });
    const id = JSON.parse(created.body).id;
    const del = await inject(app, { method: "DELETE", url: `/v1/batches/${id}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).records_removed).toBe(1);
    const after = await inject(app, { method: "GET", url: `/v1/batches/${id}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(after.statusCode).toBe(404);
    const results = await inject(app, { method: "GET", url: `/v1/batches/${id}/results`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(results.statusCode).toBe(404);
  });

  it("JSON batch over 1000 emails is rejected 413 PAYLOAD_TOO_LARGE", async () => {
    const emails = Array.from({ length: 1001 }, (_, i) => `u${i}@example.com`);
    const res = await inject(app, { method: "POST", url: "/v1/batches", headers: { authorization: `Bearer ${tokenA}` }, payload: { emails, mode: "quick" } });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("unauthenticated requests are 401 with envelope", async () => {
    const res = await inject(app, { method: "GET", url: "/v1/usage" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
  });
});

describe("Rate limiting", () => {
  it("exceeding the per-workspace bucket returns 429 RATE_LIMITED with retry_after", async () => {
    const app = await buildApp(new RateLimiter(2, 0.001));
    try {
      const reg = await inject(app, { method: "POST", url: "/v1/auth/register", payload: { email: "rl@example.com", password: "password-12345" } });
      const token = JSON.parse(reg.body).accessToken;
      const mk = () => inject(app, { method: "POST", url: "/v1/verifications", headers: { authorization: `Bearer ${token}` }, payload: { email: "person@example.com", mode: "quick" } });
      expect((await mk()).statusCode).toBe(201);
      expect((await mk()).statusCode).toBe(201);
      const third = await mk();
      expect(third.statusCode).toBe(429);
      const env = JSON.parse(third.body);
      expect(env.error.code).toBe("RATE_LIMITED");
      expect(env.error.retry_after_seconds).toBeGreaterThan(0);
    } finally { await app.close(); }
  });
});
