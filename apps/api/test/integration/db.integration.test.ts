import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaRepository } from "../../src/repositories/prisma.repository";

/**
 * REAL PostgreSQL integration tests — run ONLY when DATABASE_URL points at a
 * real Postgres (CI provides one). Skipped gracefully locally.
 *
 * They apply the hand-written init migration from @mailcheckr/database and
 * then exercise, against the real database:
 *  (a) tenant isolation at the SQL level (workspace-scoped queries), and
 *  (b) credit-ledger idempotency enforced by the real UNIQUE constraint on
 *      credit_ledger.idempotency_key.
 * These properties are NOT proven by the in-memory tests.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgreSQL integration (real DB)", () => {
  let pg: any; let client: any;
  const wsA = "11111111-1111-4111-8111-111111111111";
  const wsB = "22222222-2222-4222-8222-222222222222";
  const userA = "33333333-3333-4333-8333-333333333333";
  const userB = "44444444-4444-4444-8444-444444444444";

  beforeAll(async () => {
    const pgModule: any = await import("pg");
    pg = pgModule.default ?? pgModule;
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const migrationPath = join(__dirname, "../../../../packages/database/prisma/migrations/20261110000000_init/migration.sql");
    const sql = readFileSync(migrationPath, "utf8");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(sql);
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1,'a@integration.test','x'),($2,'b@integration.test','x')", [userA, userB]);
    await client.query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1,$2,'A'),($3,$4,'B')", [wsA, userA, wsB, userB]);
  }, 60000);

  afterAll(async () => { await client?.end(); });

  it("migration created all PRD §7 tables", async () => {
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const tables = res.rows.map((r: any) => r.table_name);
    for (const t of ["users", "workspaces", "api_keys", "verification_batches", "verification_records", "batch_rows", "credit_ledger", "domain_cache", "webhook_endpoints", "audit_events"]) {
      expect(tables).toContain(t);
    }
  });

  it("tenant isolation: workspace-scoped batch query returns nothing for the other tenant", async () => {
    const batchId = "55555555-5555-4555-8555-555555555555";
    await client.query("INSERT INTO verification_batches (id, workspace_id, source_type) VALUES ($1,$2,'api')", [batchId, wsA]);
    const mine = await client.query("SELECT id FROM verification_batches WHERE id=$1 AND workspace_id=$2", [batchId, wsA]);
    const theirs = await client.query("SELECT id FROM verification_batches WHERE id=$1 AND workspace_id=$2", [batchId, wsB]);
    expect(mine.rowCount).toBe(1);
    expect(theirs.rowCount).toBe(0);
  });

  it("ledger idempotency: the real UNIQUE constraint rejects a duplicate idempotency_key", async () => {
    await client.query("INSERT INTO credit_ledger (workspace_id, entry_type, quantity, idempotency_key) VALUES ($1,'grant',100,'it:grant:1')", [wsA]);
    await expect(
      client.query("INSERT INTO credit_ledger (workspace_id, entry_type, quantity, idempotency_key) VALUES ($1,'grant',100,'it:grant:1')", [wsA]),
    ).rejects.toMatchObject({ code: "23505" }); // unique_violation
    const sum = await client.query("SELECT SUM(quantity) AS bal FROM credit_ledger WHERE workspace_id=$1", [wsA]);
    expect(Number(sum.rows[0].bal)).toBe(100);
    await client.query("INSERT INTO credit_ledger (workspace_id, entry_type, quantity, idempotency_key) VALUES ($1,'charge',-1,'it:charge:1') ON CONFLICT (idempotency_key) DO NOTHING", [wsA]);
    await client.query("INSERT INTO credit_ledger (workspace_id, entry_type, quantity, idempotency_key) VALUES ($1,'charge',-1,'it:charge:1') ON CONFLICT (idempotency_key) DO NOTHING", [wsA]);
    const sum2 = await client.query("SELECT SUM(quantity) AS bal FROM credit_ledger WHERE workspace_id=$1", [wsA]);
    expect(Number(sum2.rows[0].bal)).toBe(99);
  });

  it("batch_rows unique (batch_id, row_number) is enforced by the real DB", async () => {
    const batchId = "55555555-5555-4555-8555-555555555555";
    await client.query("INSERT INTO batch_rows (batch_id, row_number) VALUES ($1, 1)", [batchId]);
    await expect(client.query("INSERT INTO batch_rows (batch_id, row_number) VALUES ($1, 1)", [batchId])).rejects.toMatchObject({ code: "23505" });
  });
});

/**
 * PrismaRepository runtime-path verification — the production repository
 * class itself (not raw SQL) against the real database. This is the test
 * that proves the @prisma/client dependency declared in apps/api actually
 * loads, connects, and round-trips through the generated client; the
 * in-memory suites can never prove this. Runs in the same CI step/database
 * as the suite above (DATABASE_URL must point at the integration DB; the
 * file-level beforeAll of the first suite has already applied the init
 * migration, and this suite applies the second migration so the schema
 * matches the generated client exactly).
 */
describe.skipIf(!DATABASE_URL)("PrismaRepository (real DB, production runtime path)", () => {
  let repo: PrismaRepository;
  const runId = randomUUID().slice(0, 8);
  const email = `prisma-repo-${runId}@integration.test`;
  let userId = "";
  let workspaceId = "";

  beforeAll(async () => {
    const pgModule: any = await import("pg");
    const pg = pgModule.default ?? pgModule;
    const setup = new pg.Client({ connectionString: DATABASE_URL });
    await setup.connect();
    const mig2 = readFileSync(
      join(__dirname, "../../../../packages/database/prisma/migrations/20261110010000_batch_name_and_ledger_retention/migration.sql"),
      "utf8",
    );
    await setup.query(mig2);
    await setup.end();
    repo = new PrismaRepository();
  }, 60000);

  afterAll(async () => {
    await (repo as any)?.client?.$disconnect?.();
  });

  it("user + workspace CRUD round-trip through the generated Prisma client", async () => {
    const user = await repo.createUser({ email, passwordHash: "x" });
    expect(user.id).toBeTruthy();
    expect(user.email).toBe(email);
    userId = user.id;

    const byEmail = await repo.findUserByEmail(email);
    expect(byEmail?.id).toBe(userId);
    const byId = await repo.findUserById(userId);
    expect(byId?.email).toBe(email);

    const workspace = await repo.createWorkspace({ ownerUserId: userId, name: "Prisma Repo WS", planCode: "free" });
    workspaceId = workspace.id;
    const foundWs = await repo.findWorkspaceByOwner(userId);
    expect(foundWs?.id).toBe(workspaceId);
    const wsById = await repo.findWorkspaceById(workspaceId);
    expect(wsById?.ownerUserId).toBe(userId);
  });

  it("API key + ledger + batch round-trip, tenant-scoped, ledger idempotent", async () => {
    const key = await repo.createApiKey({
      workspaceId, name: "ci-key", keyPrefix: `mc_live_ci_${runId}`, keyHash: "hash-only",
      scopes: ["verify"], expiresAt: null,
    });
    const listed = await repo.listApiKeys(workspaceId);
    expect(listed.map((k: any) => k.id)).toContain(key.id);
    const revoked = await repo.revokeApiKey(workspaceId, key.id);
    expect(revoked?.revokedAt).toBeTruthy();
    // Tenant isolation through the repository: another workspace sees nothing.
    expect(await repo.findApiKeyById("99999999-9999-4999-8999-999999999999", key.id)).toBeNull();
    expect(await repo.listApiKeys("99999999-9999-4999-8999-999999999999")).toHaveLength(0);

    const grant = { workspaceId, entryType: "grant" as const, quantity: 100, idempotencyKey: `it:prisma-repo:grant:${runId}`, batchId: null, verificationRecordId: null, description: "integration grant" };
    const first = await repo.createLedgerEntry(grant);
    const second = await repo.createLedgerEntry(grant);
    expect(second.id).toBe(first.id); // idempotent — never double-applied
    expect(await repo.sumLedger(workspaceId)).toBe(100);

    const batch = await repo.createBatch({
      workspaceId, createdByUserId: userId, name: "prisma-repo-batch", sourceType: "api",
      originalFilename: null, emailColumnName: null, mode: "quick", status: "queued",
      rowCount: 1, uniqueCount: 1, duplicateCount: 0, completedCount: 0,
      invalidCount: 0, riskyCount: 0, unknownCount: 0,
      creditsReserved: 0, creditsCharged: 0, creditsRefunded: 0,
      idempotencyKey: null, startedAt: null, completedAt: null, expiresAt: null,
    });
    expect((await repo.findBatchById(workspaceId, batch.id))?.name).toBe("prisma-repo-batch");
    expect(await repo.findBatchById("99999999-9999-4999-8999-999999999999", batch.id)).toBeNull();
  });
});
