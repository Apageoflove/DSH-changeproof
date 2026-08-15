import { describe, expect, it } from "vitest";
import { resolveImpact, type ImpactResolutionInputs } from "@host/analysis/impact-resolver.js";
import { validateConfig } from "@host/config/schema.js";
import type { HistoryEntry } from "@host/analysis/history-map.js";

const configRaw = {
  schemaVersion: 1,
  packages: [
    {
      id: "web",
      root: "packages/web",
      languages: ["typescript"],
      include: ["packages/web/src/**/*.ts", "packages/web/src/**/*.test.ts"],
      test: {
        adapter: "vitest-istanbul",
        argv: ["pnpm", "vitest", "run", "--coverage"],
        cwd: "packages/web",
        timeoutMs: 60000,
        coverageFile: "packages/web/coverage/coverage-final.json"
      }
    },
    {
      id: "api",
      root: "services/api",
      languages: ["python"],
      include: ["services/api/src/**/*.py", "services/api/tests/**/*.py"],
      test: {
        adapter: "pytest-coverage-json",
        argv: ["python", "-m", "pytest", "--cov=src", "--cov-report=json:coverage.json"],
        cwd: "services/api",
        timeoutMs: 60000,
        coverageFile: "services/api/coverage.json"
      }
    }
  ]
};

const config = validateConfig(configRaw, ".changeproof.yml");

const FILES: Record<string, string> = {
  "packages/web/src/billing/refund.ts": "export function refund() { return 1; }\n",
  "packages/web/src/billing/refund.test.ts": 'import { refund } from "./refund";\n',
  "packages/web/src/auth/login.ts": "export function login() { return 2; }\n",
  "packages/web/src/auth/login.test.ts": 'import { login } from "./login";\n',
  "packages/web/tests/other.spec.ts": 'import { refund } from "../src/billing/refund";\n',
  "services/api/src/payments/charge.py": "def charge():\n    return 1\n",
  "services/api/tests/test_charge.py": "from src.payments.charge import charge\n\ndef test_charge():\n    assert charge() == 1\n",
  "services/api/src/util/format.py": "def fmt(x):\n    return x\n",
  "services/api/tests/test_format.py": "from src.util.format import fmt\n\ndef test_fmt():\n    assert fmt(1)\n"
};
const workspaceFiles = Object.keys(FILES);

function makeInputs(overrides: Partial<ImpactResolutionInputs> = {}): ImpactResolutionInputs {
  return {
    changedFiles: [{ path: "packages/web/src/billing/refund.ts", contentDigest: "sha256:x" }],
    workspaceFiles,
    readWorkspaceFile: (p) => FILES[p] ?? null,
    config,
    historyEntries: [],
    nowIso: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

describe("impact resolver precedence (PROJECT.md 8.2)", () => {
  it("import-graph finds transitively importing tests with MEDIUM confidence", () => {
    const r = resolveImpact(makeInputs());
    const importCandidates = r.candidates.filter((c) => c.source === "import-graph");
    expect(importCandidates).toHaveLength(1);
    const c = importCandidates[0]!;
    expect(c.testFiles).toContain("packages/web/src/billing/refund.test.ts");
    expect(c.testFiles).toContain("packages/web/tests/other.spec.ts");
    expect(c.confidence).toBe("MEDIUM");
    expect(r.maxConfidence).toBe("MEDIUM");
  });

  it("explicit mapping wins and yields HIGH", () => {
    const cfg = validateConfig(
      {
        ...configRaw,
        mappings: [{ sources: ["packages/web/src/billing/**"], tests: ["packages/web/src/billing/**/*.test.ts"], confidence: "HIGH" }]
      },
      "c"
    );
    const r = resolveImpact(makeInputs({ config: cfg }));
    const explicit = r.candidates.find((c) => c.source === "explicit");
    expect(explicit).toBeDefined();
    expect(explicit!.confidence).toBe("HIGH");
    expect(explicit!.testFiles).toEqual(["packages/web/src/billing/refund.test.ts"]);
    expect(r.maxConfidence).toBe("HIGH");
  });

  it("history map with matching digest gives HIGH; drift gives MEDIUM; expired unused", () => {
    const cfg = validateConfig({ ...configRaw, coverage: { changedLinesOnly: true, requireArtifact: true, sourceMap: "auto", historyMap: { enabled: true, maxAgeDays: 14 } } }, "c");
    const entries: HistoryEntry[] = [
      { path: "packages/web/src/billing/refund.ts", contentDigest: "sha256:x", testFiles: ["packages/web/src/billing/refund.test.ts"], adapter: { id: "istanbul", version: "1.0" }, recordedAt: "2026-08-10T00:00:00.000Z" }
    ];
    const r = resolveImpact(makeInputs({ config: cfg, historyEntries: entries }));
    const history = r.candidates.find((c) => c.source === "coverage-history");
    expect(history).toBeDefined();
    expect(history!.confidence).toBe("HIGH");

    const drifted = resolveImpact(
      makeInputs({
        config: cfg,
        historyEntries: [{ ...entries[0]!, contentDigest: "sha256:old" }]
      })
    );
    expect(drifted.candidates.find((c) => c.source === "coverage-history")!.confidence).toBe("MEDIUM");

    const expired = resolveImpact(
      makeInputs({
        config: cfg,
        historyEntries: [{ ...entries[0]!, recordedAt: "2026-01-01T00:00:00.000Z" }]
      })
    );
    expect(expired.candidates.find((c) => c.source === "coverage-history")).toBeUndefined();
  });

  it("naming-convention tier merges into the higher-confidence candidate but keeps its rationale", () => {
    const r = resolveImpact(makeInputs({ changedFiles: [{ path: "packages/web/src/auth/login.ts", contentDigest: "sha256:y" }] }));
    // import-graph (MEDIUM) and naming (LOW) find the same test file: merged
    const c = r.candidates.find((x) => x.testFiles.includes("packages/web/src/auth/login.test.ts"));
    expect(c).toBeDefined();
    expect(c!.confidence).toBe("MEDIUM");
    expect(c!.rationale.some((x) => x.includes("naming convention match"))).toBe(true);
    expect(c!.rationale.some((x) => x.includes("cannot prove exhaustiveness"))).toBe(true);
  });

  it("python import graph resolves test files importing changed modules", () => {
    const r = resolveImpact(makeInputs({ changedFiles: [{ path: "services/api/src/payments/charge.py", contentDigest: "sha256:z" }] }));
    const c = r.candidates.find((x) => x.source === "import-graph" && x.packageId === "api");
    expect(c).toBeDefined();
    expect(c!.testFiles).toContain("services/api/tests/test_charge.py");
  });

  it("LOW-only impact is surfaced via maxConfidence=LOW (verdict gate)", () => {
    // remove test files from workspace: only naming remains possible but files missing
    const r = resolveImpact(
      makeInputs({
        changedFiles: [{ path: "packages/web/src/billing/refund.ts", contentDigest: "sha256:x" }],
        workspaceFiles: workspaceFiles.filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts") && !f.includes("test_"))
      })
    );
    expect(r.candidates.filter((c) => c.source !== "naming").length).toBe(0);
    expect(r.maxConfidence).toBe("LOW");
    expect(r.unresolvedPaths).toContain("packages/web/src/billing/refund.ts");
  });

  it("dynamic imports mark completeness reduced", () => {
    const FILES2: Record<string, string> = {
      "packages/web/src/billing/refund.ts": "export const x = 1;\n",
      "packages/web/src/billing/refund.test.ts": 'const m = await import("./refund");\n'
    };
    const r = resolveImpact(
      makeInputs({
        workspaceFiles: Object.keys(FILES2),
        readWorkspaceFile: (p) => FILES2[p] ?? null
      })
    );
    const c = r.candidates.find((x) => x.source === "import-graph");
    expect(c).toBeDefined();
    expect(c!.rationale.some((x) => x.includes("completeness reduced"))).toBe(true);
  });
});
