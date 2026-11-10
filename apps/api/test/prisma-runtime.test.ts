import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Runtime-path guard for the Prisma repository (Defect: @prisma/client was
 * require()d by src/repositories/prisma.repository.ts without being a
 * declared dependency of @mailcheckr/api, so under pnpm's isolated
 * node_modules layout the production repository would fail to load the
 * moment DATABASE_URL selected it — invisible to the in-memory tests).
 *
 * These tests run EVERYWHERE (not DB-gated): they assert declaration and
 * resolvability, not connectivity. Actually constructing PrismaRepository
 * against a real database is covered by the DB-gated suite in
 * test/integration/db.integration.test.ts, which runs in CI.
 */
const apiRoot = join(__dirname, "..");
const apiRequire = createRequire(join(apiRoot, "package.json"));

describe("Prisma runtime dependency (declared + resolvable)", () => {
  it("apps/api declares @prisma/client at the same version as @mailcheckr/database", () => {
    const apiPkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"));
    const dbPkg = JSON.parse(
      readFileSync(join(apiRoot, "../../packages/database/package.json"), "utf8"),
    );
    expect(apiPkg.dependencies?.["@prisma/client"]).toBeDefined();
    expect(apiPkg.dependencies["@prisma/client"]).toBe(
      dbPkg.dependencies["@prisma/client"],
    );
  });

  it("@prisma/client resolves from the API package root (pnpm layout)", () => {
    // require.resolve — NOT require(): resolution proves the dependency is
    // installed for this package; loading it would additionally demand a
    // generated client, which is a CI step (prisma generate).
    const resolved = apiRequire.resolve("@prisma/client");
    expect(resolved).toContain("@prisma/client");
  });

  it("every bare specifier the Prisma repository loads is declared in apps/api", () => {
    const source = readFileSync(
      join(apiRoot, "src/repositories/prisma.repository.ts"),
      "utf8",
    );
    const apiPkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"));
    const declared = new Set([
      ...Object.keys(apiPkg.dependencies ?? {}),
      ...Object.keys(apiPkg.devDependencies ?? {}),
    ]);
    const specifiers = new Set<string>();
    for (const m of source.matchAll(/(?:from\s+|require\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      specifiers.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
    expect(specifiers.size).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(declared, `${spec} must be declared in apps/api/package.json`).toContain(spec);
    }
  });
});
