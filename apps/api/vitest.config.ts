import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Tests run against the workspace packages' TypeScript sources (same
 *  pattern as packages/core/vitest.config.ts) so a fresh checkout can run
 *  the suite without a prior build. Production (`node dist/main.js`)
 *  resolves the built dist output via each package's package.json main. */
export default defineConfig({
  resolve: {
    alias: {
      "@mailcheckr/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@mailcheckr/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
      "@mailcheckr/datasets": fileURLToPath(new URL("../../packages/datasets/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts"], environment: "node" },
});
