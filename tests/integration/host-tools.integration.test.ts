import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { createChangeproofHost } from "@host/index.js";
import { cleanup, initRepo, makeTmpDir, writeFiles } from "../helpers/workspace.js";

let dir: string;
let cp: Awaited<ReturnType<typeof createChangeproofHost>>;

const CONFIG = `
schemaVersion: 1
packages:
  - id: web
    root: packages/web
    languages: [typescript]
    include:
      - packages/web/src/**/*.ts
    test:
      adapter: vitest-istanbul
      argv: [node, does-not-matter]
      cwd: packages/web
      timeoutMs: 30000
      coverageFile: packages/web/coverage/coverage-final.json
thresholds:
  changedLines: 1.0
  minimumImpactConfidence: MEDIUM
`;

beforeAll(async () => {
  dir = await makeTmpDir("host-tools");
  await initRepo(dir, {
    ".changeproof.yml": CONFIG,
    "packages/web/src/util/math.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    "packages/web/src/util/math.test.ts": 'import { add } from "./math";\n\nfunction assert(x: boolean) {\n  if (!x) throw new Error("fail");\n}\n\nassert(add(1, 2) === 3);\n'
  });
  cp = await createChangeproofHost();
  await cp.activate();
});

afterAll(async () => {
  cp.dispose();
  await cleanup(dir);
});

describe("changeproof_plan (integration, real git)", () => {
  it("returns canonical structured result with ChangeSet and impact", async () => {
    await writeFiles(dir, {
      "packages/web/src/util/math.ts": "export function add(a: number, b: number) {\n  return a + b + 0;\n}\n"
    });
    const res = await cp.tools.invoke("changeproof_plan", { workspace: dir });
    expect(res.ok).toBe(true);
    expect(res.schemaVersion).toBe("1.0");
    expect(res.kind).toBe("changeproof_plan");
    expect(res.error).toBeNull();
    const data = res.data as {
      changeSetSummary: { mode: string; files: Array<{ path: string; status: string }>; digest: string };
      impact: { maxConfidence: string; candidates: Array<{ testFiles: string[]; source: string; confidence: string }> };
      preview: Array<{ argv: string[]; cwd: string }>;
      planId: string;
      workspaceFingerprint: string;
    };
    expect(data.changeSetSummary.mode).toBe("git");
    const changed = data.changeSetSummary.files.find((f) => f.path === "packages/web/src/util/math.ts");
    expect(changed).toBeDefined();
    expect(data.changeSetSummary.digest).toMatch(/^sha256:/);
    expect(data.impact.maxConfidence).toBe("MEDIUM");
    expect(data.impact.candidates[0]!.testFiles).toContain("packages/web/src/util/math.test.ts");
    expect(data.preview[0]!.cwd).toBe("packages/web");
    expect(data.planId).toMatch(/^sha256:/);
    expect(data.workspaceFingerprint).toMatch(/^sha256:/);
  });

  it("is deterministic: same workspace → same digest/fingerprint/planId", async () => {
    const a = await cp.tools.invoke("changeproof_plan", { workspace: dir });
    const b = await cp.tools.invoke("changeproof_plan", { workspace: dir });
    const da = a.data as { planId: string; workspaceFingerprint: string };
    const db = b.data as { planId: string; workspaceFingerprint: string };
    expect(da.planId).toBe(db.planId);
    expect(da.workspaceFingerprint).toBe(db.workspaceFingerprint);
  });

  it("fails structurally (not by throw) when config is missing", async () => {
    const empty = await makeTmpDir("no-config");
    try {
      const res = await cp.tools.invoke("changeproof_plan", { workspace: empty });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("CP_CONFIG_NOT_FOUND");
    } finally {
      await cleanup(empty);
    }
  });

  it("fails structurally outside a git repo", async () => {
    const nogit = await makeTmpDir("no-git");
    try {
      await writeFiles(nogit, { ".changeproof.yml": CONFIG });
      const res = await cp.tools.invoke("changeproof_plan", { workspace: nogit });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("CP_NOT_A_GIT_REPO");
    } finally {
      await cleanup(nogit);
    }
  });
});

describe("changeproof_status (integration)", () => {
  it("reports no-evidence before any verify", async () => {
    const res = await cp.tools.invoke("changeproof_status", { workspace: dir });
    expect(res.ok).toBe(true);
    const data = res.data as { freshness: string; latestEvidence: unknown; workspaceFingerprint: string };
    expect(data.freshness).toBe("no-evidence");
    expect(data.latestEvidence).toBeNull();
  });
});

describe("tool registration lifecycle", () => {
  it("dispose removes all tools (no residue)", async () => {
    const cp2 = await createChangeproofHost();
    await cp2.activate();
    expect(cp2.tools.list().map((t) => t.id).sort()).toEqual(["changeproof_plan", "changeproof_status", "changeproof_verify"]);
    cp2.dispose();
    expect(cp2.tools.list()).toHaveLength(0);
  });
});

void path;
