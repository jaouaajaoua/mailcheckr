import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@mailcheckr/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      "@mailcheckr/datasets": fileURLToPath(new URL("../datasets/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
