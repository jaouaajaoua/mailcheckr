import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REASON_CODES, VERIFICATION_STATUSES } from "@mailcheckr/contracts";
import { AppModule } from "../src/app.module";

/**
 * OpenAPI route-coverage test (PRD §8 / Phase 6).
 *
 * The expected route set is DERIVED from the controller source files —
 * every `@Controller(...)` base path combined with every HTTP-method
 * decorator in that file — never hand-listed here. Adding a route without
 * documenting it in docs/openapi.json (or documenting a route that no
 * longer exists) fails this suite. The spec is JSON (docs/openapi.json),
 * parsed with JSON.parse: no YAML dependency is installed in the
 * workspace, and JSON is a valid OpenAPI serialization.
 */

/** Locate the package/repo roots by walking up from the cwd (vitest runs
 *  from apps/api) to the directory containing docs/openapi.json. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "docs", "openapi.json")) && existsSync(join(dir, "apps", "api", "src"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the mailcheckr repo root (docs/openapi.json).");
}
const repoRoot = findRepoRoot();
const apiRoot = join(repoRoot, "apps", "api");
const specPath = join(repoRoot, "docs", "openapi.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

interface Route {
  method: string; // lowercase http method
  path: string; // OpenAPI style, e.g. /v1/batches/{id}
}

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

/** Extract routes from Nest controller sources. Controller decorators and
 *  method decorators are matched in source order; each method decorator is
 *  attributed to the file's (single) @Controller base path. */
export function extractControllerRoutes(srcDir: string): Route[] {
  const routes: Route[] = [];
  for (const file of controllerFiles(srcDir)) {
    const src = readFileSync(file, "utf8");
    const ctrl = src.match(/@Controller\(\s*(?:"([^"]*)")?\s*\)/);
    if (!ctrl) continue;
    const base = (ctrl[1] ?? "").replace(/^\/+|\/+$/g, "");
    const methodRe = /@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g;
    for (const m of src.matchAll(methodRe)) {
      const sub = (m[2] ?? "").replace(/^\/+|\/+$/g, "");
      const joined = [base, sub].filter(Boolean).join("/");
      const path = ("/" + joined).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
      routes.push({ method: m[1].toLowerCase(), path });
    }
  }
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

function specRoutes(): Route[] {
  const routes: Route[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) routes.push({ method, path });
    }
  }
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

const expected = extractControllerRoutes(join(apiRoot, "src"));

describe("OpenAPI 3.1 spec (docs/openapi.json)", () => {
  it("is an OpenAPI 3.1 document with both security schemes", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.components.securitySchemes.bearerJwt).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(spec.components.securitySchemes.bearerApiKey).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.components.securitySchemes.bearerApiKey.description).toContain("mc_live_");
  });

  it("derives a non-trivial route set from the controller sources", () => {
    // Guards against the extractor silently matching nothing (which would
    // make the coverage assertions below vacuous).
    expect(expected.length).toBeGreaterThanOrEqual(24);
    expect(expected).toContainEqual({ method: "post", path: "/v1/verifications" });
    expect(expected).toContainEqual({ method: "get", path: "/health" });
    expect(expected).toContainEqual({ method: "get", path: "/v1/openapi.json" });
  });

  it("documents EVERY controller route — no missing routes", () => {
    const documented = new Set(specRoutes().map((r) => `${r.method} ${r.path}`));
    const missing = expected.filter((r) => !documented.has(`${r.method} ${r.path}`));
    expect(missing).toEqual([]);
  });

  it("contains no stale routes that no controller exposes", () => {
    const live = new Set(expected.map((r) => `${r.method} ${r.path}`));
    const stale = specRoutes().filter((r) => !live.has(`${r.method} ${r.path}`));
    expect(stale).toEqual([]);
  });

  it("reuses the @mailcheckr/contracts enums exactly (statuses + all 24 reason codes)", () => {
    expect(spec.components.schemas.VerificationStatus.enum).toEqual([...VERIFICATION_STATUSES]);
    expect(spec.components.schemas.ReasonCode.enum).toEqual([...REASON_CODES]);
    expect(spec.components.schemas.ReasonCode.enum).toHaveLength(24);
    expect(spec.components.schemas.VerificationStatus.enum).not.toContain("duplicate");
  });

  it("uses the shared error envelope for error responses", () => {
    const envelope = spec.components.schemas.ErrorEnvelope;
    expect(envelope.properties.error.required).toEqual(["code", "message", "request_id"]);
    const post = spec.paths["/v1/verifications"].post;
    expect(JSON.stringify(post.responses)).toContain("#/components/schemas/ErrorEnvelope");
  });

  it("documents Deep mode honestly: gated/BLOCKED, capped, never valid", () => {
    const text = JSON.stringify(spec.paths["/v1/verifications"]) + JSON.stringify(spec.info);
    expect(text).toContain("smtp_port_unavailable");
    expect(text).toMatch(/BLOCKED/);
    expect(text).toMatch(/never returns `valid`|never `valid`|never a fabricated/i);
    expect(spec.components.schemas.SingleVerificationRequest.properties.mode.description).toMatch(/BLOCKED/);
  });

  it("keeps public routes public and protected routes secured", () => {
    expect(spec.paths["/health"].get.security).toEqual([]);
    expect(spec.paths["/v1/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/v1/auth/register"].post.security).toEqual([]);
    const secured = spec.paths["/v1/verifications"].post.security;
    expect(secured).toEqual([{ bearerJwt: [] }, { bearerApiKey: [] }]);
  });
});

describe("GET /v1/openapi.json (served by the API)", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (app as any).getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns 200 without credentials and serves exactly the checked-in spec", async () => {
    const res = await (app as any).getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const served = JSON.parse(res.body);
    expect(served.openapi).toBe("3.1.0");
    expect(served.paths).toEqual(spec.paths);
    expect(Object.keys(served.paths).length).toBeGreaterThanOrEqual(20);
  });
});
