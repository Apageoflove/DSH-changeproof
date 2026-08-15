import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { symlink, rm, mkdir, writeFile } from "node:fs/promises";
import { createChangeproofHost } from "@host/index.js";
import { cleanup, initRepo, makeTmpDir, writeFiles, nodeExe, pluginVitestPath, projectRoot } from "../helpers/workspace.js";

/**
 * REAL runner integration: the fixture workspace executes this plugin's own
 * vitest binary (real subprocess, real @vitest/coverage-v8, real Istanbul
 * coverage-final.json). The fixture's node_modules is a junction to the
 * plugin's node_modules — a standard monorepo dependency layout; the junction
 * itself is skipped by ChangeProof's scanner and never part of any configured
 * path (cwd/coverageFile/sources stay inside the fixture).
 */
let dir: string;
let cp: Awaited<ReturnType<typeof createChangeproofHost>>;

const ADD_TS = `export function add(a: number, b: number) {
  const sum = a + b;
  return sum;
}

export function divide(a: number, b: number) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}
`;

const ADD_TEST_TS = `import { describe, expect, it } from "vitest";
import { add, divide } from "./add";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});

describe("divide", () => {
  it("divides", () => {
    expect(divide(6, 3)).toBe(2);
  });
  it("throws on zero", () => {
    expect(() => divide(1, 0)).toThrow("division by zero");
  });
});
`;

function configYaml(): string {
  return `
schemaVersion: 1
packages:
  - id: web
    root: ""
    languages: [typescript]
    include:
      - src/**/*.ts
    test:
      adapter: vitest-istanbul
      argv: [${JSON.stringify(nodeExe)}, ${JSON.stringify(pluginVitestPath())}, "run", "--coverage"]
      cwd: ""
      timeoutMs: 120000
      coverageFile: coverage/coverage-final.json
thresholds:
  changedLines: 1.0
  minimumImpactConfidence: MEDIUM
`;
}

beforeAll(async () => {
  cp = await createChangeproofHost();
  await cp.activate();
  dir = await makeTmpDir("js-vitest");
  await initRepo(dir, {
    ".changeproof.yml": configYaml(),
    ".gitignore": "node_modules\ncoverage\n.changeproof\n",
    "package.json": JSON.stringify({ name: "fixture-js", type: "module", private: true }, null, 2),
    "vitest.config.ts": `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  coverage: { provider: "v8", reporter: ["json"], reportsDirectory: "coverage", include: ["src/**"] }
});
`,
    "src/add.ts": ADD_TS,
    "src/add.test.ts": ADD_TEST_TS
  });
  await symlink(path.join(projectRoot, "node_modules"), path.join(dir, "node_modules"), "junction");
  // THE CHANGE: rewrite src/add.ts (all lines executable; tests cover them)
  await writeFiles(dir, {
    "src/add.ts": `export function add(a: number, b: number) {
  const sum = a + b + 0;
  return sum;
}

export function divide(a: number, b: number) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}
`
  });
});

afterAll(async () => {
  cp.dispose();
  await rm(path.join(dir, "node_modules"), { force: true }).catch(() => {});
  await cleanup(dir);
});

describe("JS workspace with REAL vitest + istanbul coverage", () => {
  it("plan: real vitest argv preview, impact via import graph", async () => {
    const res = await cp.tools.invoke("changeproof_plan", { workspace: dir });
    expect(res.ok).toBe(true);
    const data = res.data as { preview: Array<{ argv: string[] }>; impact: { maxConfidence: string }; changeSetSummary?: { files?: Array<{ path: string }> } };
    const vitestPreview = data.preview.find((p) => p.argv.some((a) => a.includes("vitest.mjs")));
    expect(vitestPreview).toBeDefined();
    expect(data.impact.maxConfidence).toBe("MEDIUM");
  }, 60_000);

  it("verify: real vitest run → real artifact → VERIFIED with 100% changed-line coverage", async () => {
    const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
    expect(res.ok).toBe(true);
    const data = res.data as {
      verdict: { status: string; changedLineCoverage: { threshold: number; actual: number | null } };
      changedLineCoverageSummary: { coverableTotal: number; coveredTotal: number; ratio: number | null };
      evidence: Array<{ stepId: string; exitCode: number | null; parser: { status: string } }>;
    };
    expect(data.verdict.status).toBe("VERIFIED");
    expect(data.changedLineCoverageSummary.coverableTotal).toBeGreaterThan(0);
    expect(data.changedLineCoverageSummary.ratio).toBe(1);
    const testStep = data.evidence.find((e) => e.stepId.startsWith("targeted-test"));
    expect(testStep!.exitCode).toBe(0);
    const parseStep = data.evidence.find((e) => e.stepId.startsWith("changed-line-coverage"));
    expect(parseStep!.parser.status).toBe("ok");
  }, 180_000);

  it("verify again after breaking a test → FAILED (real assertion failure)", async () => {
    await writeFile(path.join(dir, "src/add.test.ts"), ADD_TEST_TS.replace("expect(add(1, 2)).toBe(3)", "expect(add(1, 2)).toBe(4)"), "utf8");
    const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
    const data = res.data as { verdict: { status: string; reasons: Array<{ code: string }> } };
    expect(data.verdict.status).toBe("FAILED");
    expect(data.verdict.reasons.some((r) => r.code === "CP_REQUIRED_CHECK_FAILED")).toBe(true);
    // restore
    await writeFile(path.join(dir, "src/add.test.ts"), ADD_TEST_TS, "utf8");
  }, 180_000);

  it("uncovered NEW changed lines → PARTIAL with uncovered lines listed", async () => {
    // add an untested function: its lines are NEW executable changed lines
    // with zero coverage — changed-line coverage drops below threshold.
    await writeFile(
      path.join(dir, "src/add.ts"),
      `export function add(a: number, b: number) {
  const sum = a + b + 0;
  return sum;
}

export function divide(a: number, b: number) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}

export function mul(a: number, b: number) {
  if (b === 1) {
    return a;
  }
  return a * b;
}
`,
      "utf8"
    );
    const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
    const data = res.data as {
      verdict: { status: string; reasons: Array<{ code: string }> };
      changedLineCoverageSummary: { ratio: number | null; uncoveredTotal: number };
    };
    expect(data.verdict.status).toBe("PARTIAL");
    expect(data.verdict.reasons.some((r) => r.code === "CP_COVERAGE_BELOW_THRESHOLD")).toBe(true);
    expect(data.changedLineCoverageSummary.uncoveredTotal).toBeGreaterThan(0);
    expect(data.changedLineCoverageSummary.ratio).toBeLessThan(1);
    // restore
    await writeFile(
      path.join(dir, "src/add.ts"),
      ADD_TS.replace("a + b;", "a + b + 0;"),
      "utf8"
    );
  }, 180_000);
});

void mkdir;
