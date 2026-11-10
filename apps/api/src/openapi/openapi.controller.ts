import { Controller, Get } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Public } from "../auth/auth.guard";
import { ApiError } from "../common/errors";

/**
 * Serves the machine-readable OpenAPI 3.1 specification (PRD §8 / Phase 6).
 *
 * The spec is a checked-in static document — `docs/openapi.json` at the
 * repository root — NOT generated from decorators, so what integrators read
 * is exactly what is reviewed in the repo. Drift is prevented by
 * `apps/api/test/openapi.test.ts`, which extracts every route from the
 * controller sources and fails if any route is missing from (or stale in)
 * this document.
 *
 * Path resolution works for every runtime layout this codebase uses:
 *  - vitest / tsx (sources):  src/openapi/  -> ../../../../docs/openapi.json
 *  - compiled (dist):        dist/openapi/ -> ../../../../docs/openapi.json
 *    (both are exactly four levels below the repository root)
 *  - explicit override:      OPENAPI_SPEC_PATH env var
 *  - last resort:            <cwd>/docs/openapi.json and <cwd>/../../docs/…
 */
export function resolveOpenApiSpecPath(): string | null {
  const candidates: string[] = [];
  if (process.env.OPENAPI_SPEC_PATH) candidates.push(process.env.OPENAPI_SPEC_PATH);
  candidates.push(join(__dirname, "..", "..", "..", "..", "docs", "openapi.json"));
  candidates.push(join(process.cwd(), "docs", "openapi.json"));
  candidates.push(join(process.cwd(), "..", "..", "docs", "openapi.json"));
  candidates.push(join(process.cwd(), "..", "..", "..", "docs", "openapi.json"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cached: Record<string, unknown> | null = null;

export function loadOpenApiSpec(): Record<string, unknown> {
  if (cached) return cached;
  const path = resolveOpenApiSpecPath();
  if (!path) {
    throw new ApiError(
      "OPENAPI_SPEC_NOT_FOUND",
      "The OpenAPI specification file (docs/openapi.json) could not be located on this server.",
      500,
    );
  }
  cached = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return cached;
}

@Controller("v1")
export class OpenApiController {
  /** Public on purpose: integrators and tooling fetch the contract without
   *  credentials. Returns the parsed spec document as JSON. */
  @Public() @Get("openapi.json")
  openApi() {
    return loadOpenApiSpec();
  }
}
