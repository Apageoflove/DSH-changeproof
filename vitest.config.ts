import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      reporter: ["text", "json-summary"]
    }
  },
  resolve: {
    alias: {
      "@shared": r("./src/shared"),
      "@host": r("./src/host"),
      "@client": r("./src/client")
    }
  }
});
