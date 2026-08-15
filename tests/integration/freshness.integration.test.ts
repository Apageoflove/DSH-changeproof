import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { createChangeproofHost } from "@host/index.js";
import { cleanup, initRepo, makeTmpDir, writeFiles, nodeExe, projectRoot } from "../helpers/workspace.js";

const fakeRunner = path.join(projectRoot, "fixtures", "fake-runner.mjs");

/**
 * Fixture factory: a git repo with one changed source file whose executable
 * lines are known; the "runner" is a real node subprocess writing a real
 * Istanbul artifact.
 */
async function makeWorkspace(mode: string, coverageSpec: string[]): Promise<string> {
  const dir = await makeTmpDir("fresh");
  const src = "packages/web/src/calc.ts";
  // baseline: 3 executable lines (2,3,4) inside function starting line 1
  await initRepo(dir, {
    ".changeproof.yml": `
schemaVersion: 1
packages:
  - id: web
    root: packages/web
    languages: [typescript]
    include:
      - packages/web/src/**/*.ts
    test:
      adapter: vitest-istanbul
      argv: [${JSON.stringify(nodeExe)}, ${JSON.stringify(fakeRunner)}, ${JSON.stringify(mode)}, "packages/web/coverage/coverage-final.json", ${coverageSpec.map((s) => JSON.stringify(s)).join(", ")}]
      cwd: ""
      timeoutMs: 20000
      coverageFile: packages/web/coverage/coverage-final.json
`,
    [src]: "export function calc(x: number) {\n  const y = x + 1;\n  return y;\n}\n",
    "packages/web/src/calc.test.ts": 'import { calc } from "./calc";\nif (calc(1) !== 2) throw new Error("x");\n'
  });
  // change lines 2-4 (all executable) relative to HEAD
  await writeFiles(dir, {
    [src]: "export function calc(x: number) {\n  const y = x + 2;\n  const z = y * 2;\n  return z;\n}\n"
  });
  return dir;
}

const FULL = ["packages/web/src/calc.ts:2,3,4:2,3,4"]; // executable 2,3,4 all covered
const PARTIAL = ["packages/web/src/calc.ts:2,3,4:2,3"]; // line 4 uncovered
const MISSING_FILE: string[] = []; // artifact without the changed file → gap

let cp: Awaited<ReturnType<typeof createChangeproofHost>>;

beforeAll(async () => {
  cp = await createChangeproofHost();
  await cp.activate();
});
afterAll(() => cp.dispose());

describe("freshness lifecycle (real subprocess + real artifacts)", () => {
  it("VERIFIED: relevant tests pass and changed executable lines are covered", async () => {
    const dir = await makeWorkspace("pass-with-coverage", FULL);
    try {
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      expect(res.ok).toBe(true);
      const data = res.data as { verdict: { status: string }; evidence: Array<{ parser: { status: string } }> };
      expect(data.verdict.status).toBe("VERIFIED");
      expect(data.evidence.some((e) => e.parser.status === "ok")).toBe(true);
      const status = await cp.tools.invoke("changeproof_status", { workspace: dir });
      expect((status.data as { freshness: string }).freshness).toBe("fresh");
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("STALE: mutation after verification invalidates evidence (never keeps VERIFIED)", async () => {
    const dir = await makeWorkspace("pass-with-coverage", FULL);
    try {
      const first = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      expect((first.data as { verdict: { status: string } }).verdict.status).toBe("VERIFIED");

      await writeFiles(dir, { "packages/web/src/calc.ts": "export function calc(x: number) {\n  const y = x + 3;\n  const z = y * 2;\n  return z;\n}\n" });

      const st = await cp.tools.invoke("changeproof_status", { workspace: dir });
      const stData = st.data as { freshness: string; staleReason: string | null };
      expect(stData.freshness).toBe("stale");
      expect(stData.staleReason).toMatch(/fingerprint/);

      // verify re-evaluates against the NEW fingerprint: evidence is rebuilt
      const second = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      expect((second.data as { verdict: { status: string } }).verdict.status).toBe("VERIFIED");
      const st2 = await cp.tools.invoke("changeproof_status", { workspace: dir });
      expect((st2.data as { freshness: string }).freshness).toBe("fresh");
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("UNVERIFIED: exit 0 without coverage artifact", async () => {
    const dir = await makeWorkspace("no-artifact", MISSING_FILE);
    try {
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as { verdict: { status: string; reasons: Array<{ code: string }> } };
      expect(data.verdict.status).toBe("UNVERIFIED");
      // exit 0 but the artifact is absent: loud failure, never a green light
      expect(
        data.verdict.reasons.some((r) =>
          ["CP_COVERAGE_PARSE_ERROR", "CP_COVERAGE_ARTIFACT_MISSING", "CP_COVERAGE_GAP_FILES"].includes(r.code)
        )
      ).toBe(true);
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("FAILED: test assertion failure (exit 1)", async () => {
    const dir = await makeWorkspace("fail", FULL);
    try {
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as { verdict: { status: string; reasons: Array<{ code: string }> } };
      expect(data.verdict.status).toBe("FAILED");
      expect(data.verdict.reasons.some((r) => r.code === "CP_REQUIRED_CHECK_FAILED")).toBe(true);
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("PARTIAL: coverage below threshold with trustworthy evidence", async () => {
    const dir = await makeWorkspace("pass-with-coverage", PARTIAL);
    try {
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as { verdict: { status: string; reasons: Array<{ code: string }> } };
      expect(data.verdict.status).toBe("PARTIAL");
      expect(data.verdict.reasons.some((r) => r.code === "CP_COVERAGE_BELOW_THRESHOLD")).toBe(true);
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("UNVERIFIED: changed file absent from the artifact is a coverage gap", async () => {
    const dir = await makeWorkspace("pass-with-coverage", ["packages/web/src/other.ts:1:1"]);
    try {
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as { verdict: { status: string; reasons: Array<{ code: string }> } };
      expect(data.verdict.status).not.toBe("VERIFIED");
      expect(data.verdict.reasons.some((r) => r.code === "CP_COVERAGE_GAP_FILES")).toBe(true);
    } finally {
      await cleanup(dir);
    }
  }, 60_000);

  it("approval denial cancels execution and yields structured evidence", async () => {
    const dir = await makeWorkspace("pass-with-coverage", FULL);
    try {
      const res = await verifyWithApproval(dir, () => Promise.resolve(false));
      const data = res.data as { verdict: { status: string }; evidence: Array<{ termination: string }> };
      expect(data.verdict.status).toBe("FAILED"); // cancelled required check = FAILED per state machine
      expect(data.evidence.some((e) => e.termination === "cancelled")).toBe(true);
    } finally {
      await cleanup(dir);
    }
  }, 60_000);
});

async function verifyWithApproval(dir: string, approve: (preview: { argv: string[]; riskLevel: string }) => Promise<boolean>) {
  const { verifyTool } = await import("@host/tools/verify.js");
  const host = await createHostContextShim();
  const result = await verifyTool(host, dir, { approve: approve as never });
  return result;
}

async function createHostContextShim() {
  const { createHostContext } = await import("@host/adapters/dsh/compatibility-facade.js");
  return createHostContext();
}
