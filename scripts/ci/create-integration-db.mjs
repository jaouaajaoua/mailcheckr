#!/usr/bin/env node
/**
 * CI helper: create the dedicated integration-test database.
 *
 * Why a separate database? apps/api/test/integration/db.integration.test.ts
 * OWNS its schema: it runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
 * and then applies ONLY the hand-written init migration
 * (packages/database/prisma/migrations/20261110000000_init/migration.sql)
 * via raw `pg`. Running `prisma migrate deploy` against that same database
 * first would conflict (the test would destroy the migrated state, including
 * the `_prisma_migrations` table and the second migration's changes).
 *
 * Resolution used by .github/workflows/ci.yml:
 *   - `mailcheckr_test`        -> prisma validate/generate/migrate deploy
 *                                 evidence against a real PostgreSQL 16.
 *   - `mailcheckr_integration` -> owned end-to-end by the DB integration
 *                                 tests (drop/recreate schema, apply the
 *                                 init migration themselves).
 *
 * Usage:
 *   ADMIN_DATABASE_URL=postgresql://user:pass@localhost:5432/postgres \
 *     node scripts/ci/create-integration-db.mjs [dbName]
 *
 * `pg` is loaded via createRequire anchored at apps/api/package.json because
 * `pg` is a devDependency of @mailcheckr/api and pnpm does not hoist it to
 * the workspace root.
 */
import { createRequire } from "node:module";

const adminUrl = process.env.ADMIN_DATABASE_URL;
const dbName = process.argv[2] ?? process.env.INTEGRATION_DB_NAME ?? "mailcheckr_integration";

if (!adminUrl) {
  console.error("create-integration-db: ADMIN_DATABASE_URL is required");
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*$/.test(dbName)) {
  console.error(`create-integration-db: unsafe database name: ${dbName}`);
  process.exit(1);
}

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Client } = require("pg");

const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (existing.rowCount === 0) {
    // dbName is validated above to a strict identifier charset; CREATE
    // DATABASE cannot take a bind parameter for the name.
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`create-integration-db: created database ${dbName}`);
  } else {
    console.log(`create-integration-db: database ${dbName} already exists`);
  }
} finally {
  await client.end();
}
