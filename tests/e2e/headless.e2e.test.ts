import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { symlink, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initRepo, makeTmpDir, writeFiles, cleanup, projectRoot, nodeExe } from "../helpers/workspace.js";

const execFileAsync = promisify(execFile);
const CLI = path.join(projectRoot, "dist", "host", "cli.mjs");
const VITEST = "E:/agent/dsh-changeproof/node_modules/vitest/vitest.mjs";

const ADD_TS = `export function add(a: number, b: number) {
  const sum = a + b;
  return sum;
}
`;
const ADD_TEST = `import { describe, expect, it } from "vitest";
import { add } from "./add";

describe("add", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
`;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(nodeExe, [CLI, ...args], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" } as never
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

let dir: string;

beforeAll(async () => {
  // build dist from source: the E2E proves the SHIPPED artifact, not just ts source
  await execFileAsync(nodeExe, [path.join(projectRoot, "scripts", "build.mjs")], { cwd: projectRoot });
  dir = await makeTmpDir("e2e-headless");
  await initRepo(dir, {
    ".changeproof.yml": `
schemaVersion: 1
packages:
  - id: web
    root: ""
    languages: [typescript]
    include:
      - src/**/*.ts
    test:
      adapter: vitest-istanbul
      argv: [${JSON.stringify(nodeExe)}, ${JSON.stringify(VITEST)}, "run", "--coverage"]
      cwd: ""
      timeoutMs: 180000
      coverageFile: coverage/coverage-final.json
`,
    ".gitignore": "node_modules\ncoverage\n.changeproof\n",
    "package.json": '{"name":"e2e-fixture","type":"module","private":true}',
    "vitest.config.ts": [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      '  test: { include: ["src/**/*.test.ts"] },',
      '  coverage: { provider: "v8", reporter: ["json"], reportsDirectory: "coverage", include: ["src/**"] }',
      "});",
      ""
    ].join("\n"),
    "src/add.ts": ADD_TS,
    "src/add.test.ts": ADD_TEST
  });
  await symlink(path.join(projectRoot, "node_modules"), path.join(dir, "node_modules"), "junction");
  // THE CHANGE (semantically equivalent: sum still equals a+b)
  await writeFile(path.join(dir, "src/add.ts"), ADD_TS.replace("a + b;", "(a + b) + 0;"), "utf8");
}, 300_000);

afterAll(async () => {
  if (dir) {
    await rm(path.join(dir, "node_modules"), { force: true }).catch(() => {});
    await cleanup(dir);
  }
});

describe("headless E2E: real CLI + real vitest (PROJECT.md 17.2 web/headless rows)", () => {
  it("plan prints canonical JSON without executing project code", async () => {
    const res = await cli(["plan", "--workspace", dir]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop()!) as {
      schemaVersion: string;
      kind: string;
      ok: boolean;
      data: { changeSetSummary: { files: { path: string }[] }; impact: { maxConfidence: string }; planId: string; preview: { argv: string[] }[] };
    };
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.kind).toBe("changeproof_plan");
    expect(parsed.data.changeSetSummary.files.map((f) => f.path)).toContain("src/add.ts");
    expect(parsed.data.impact.maxConfidence).toBe("MEDIUM");
    expect(parsed.data.preview.length).toBeGreaterThan(0);
  }, 120_000);

  it("verify without --yes refuses to execute (approval gate, exit 65)", async () => {
    const res = await cli(["verify", "--workspace", dir]);
    expect(res.code).toBe(65);
    expect(res.stderr).toContain("commands to execute");
    expect(res.stderr).toContain("REAL side effects");
  }, 120_000);

  it("verify --yes runs the real suite → VERIFIED, exit 0 per EXIT_POLICY", async () => {
    const res = await cli(["verify", "--workspace", dir, "--yes"]);
    const parsed = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop()!) as {
      ok: boolean;
      data: { verdict: { status: string; changedLineCoverage: { actual: number | null } }; changedLineCoverageSummary: { ratio: number | null } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.verdict.status).toBe("VERIFIED");
    expect(parsed.data.verdict.changedLineCoverage.actual).toBe(1);
    expect(res.code).toBe(0);
  }, 300_000);

  it("status is fresh right after verification", async () => {
    const res = await cli(["status", "--workspace", dir]);
    const parsed = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop()!) as { data: { freshness: string } };
    expect(parsed.data.freshness).toBe("fresh");
  }, 60_000);

  it("mutation → status stale → re-verify now FAILED (test expects 3, impl returns 4)", async () => {
    await writeFile(path.join(dir, "src/add.ts"), ADD_TS.replace("a + b;", "1 + (a + b);"), "utf8");
    const st = await cli(["status", "--workspace", dir]);
    const stParsed = JSON.parse(st.stdout.trim().split("\n").filter(Boolean).pop()!) as { data: { freshness: string; staleReason: string | null } };
    expect(stParsed.data.freshness).toBe("stale");
    expect(stParsed.data.staleReason).toMatch(/fingerprint/);

    const rv = await cli(["verify", "--workspace", dir, "--yes"]);
    const rvParsed = JSON.parse(rv.stdout.trim().split("\n").filter(Boolean).pop()!) as {
      data: { verdict: { status: string; reasons: { code: string }[] } };
    };
    expect(rvParsed.data.verdict.status).toBe("FAILED");
    expect(rvParsed.data.verdict.reasons.some((r) => r.code === "CP_REQUIRED_CHECK_FAILED")).toBe(true);
    expect(rv.code).toBe(1); // EXIT_POLICY[FAILED] === 1
  }, 300_000);

  it("status reflects the newest evidence after re-verification", async () => {
    const st = await cli(["status", "--workspace", dir]);
    const parsed = JSON.parse(st.stdout.trim().split("\n").filter(Boolean).pop()!) as { data: { freshness: string; latestEvidence: { exitCode: number | null } | null } };
    expect(parsed.data.freshness).toBe("fresh");
    expect(parsed.data.latestEvidence).not.toBeNull();
  }, 60_000);
});
