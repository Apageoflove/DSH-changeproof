/**
 * Verification planner: cheap → targeted tests (+ coverage artifact) →
 * changed-line coverage parse (PROJECT.md 8.3). No project code executes at
 * planning time. Mutation smoke is deliberately NOT planned in MVP.
 */
import type { Digest, ImpactCandidate, VerificationPlan, VerificationStep } from "../../shared/models.ts";
import { canonicalJsonStringify } from "../../shared/schema.ts";
import type { ChangeProofConfig } from "../config/schema.ts";
import { vitestAdapter, jestAdapter } from "../adapters/javascript/vitest-jest.ts";
import { pytestAdapter } from "../adapters/python/pytest-coverage.ts";
import type { HashFn } from "../analysis/fingerprint.ts";

function adapterFor(id: string) {
  switch (id) {
    case "vitest-istanbul":
      return vitestAdapter;
    case "jest-istanbul":
      return jestAdapter;
    case "pytest-coverage-json":
      return pytestAdapter;
    default:
      throw new Error(`unknown adapter id: ${id}`);
  }
}

/** Convert workspace-relative test paths to paths relative to the step cwd. */
export function rebaseToCwd(files: string[], cwd: string): string[] {
  if (cwd === "") return [...files];
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return files.map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));
}

export interface PlanInputs {
  config: ChangeProofConfig;
  candidates: ImpactCandidate[];
  changeSetDigest: Digest;
  workspaceFingerprint: Digest;
  nowIso: string;
}

export function buildPlan(inputs: PlanInputs, hash: HashFn): VerificationPlan {
  const { config, candidates } = inputs;
  const steps: VerificationStep[] = [];
  const diagnostics: string[] = [];

  // tier 1: cheap checks from config
  for (const check of config.checks.filter((c) => c.tier === "cheap")) {
    steps.push({
      id: `cheap:${check.id}`,
      tier: "cheap",
      required: check.required,
      adapterId: "process",
      argv: check.argv ?? [],
      cwd: check.cwd,
      timeoutMs: check.timeoutMs,
      expectedArtifacts: [],
      dependsOn: [],
      rationale: [`configured cheap check "${check.id}"`]
    });
  }

  // tier 2+3: targeted tests per package (produces the coverage artifact)
  const cheapStepIds = steps.filter((s) => s.tier === "cheap" && s.required).map((s) => s.id);
  const targetedStepIds: string[] = [];
  const packagesWithCandidates = new Set(candidates.map((c) => c.packageId));
  for (const pkg of config.packages) {
    const pkgCandidates = candidates.filter((c) => c.packageId === pkg.id && c.testFiles.length > 0);
    const checkOverride = config.checks.find((c) => c.tier === "targeted-test" && c.packageId === pkg.id);
    const needed = pkgCandidates.length > 0 || (checkOverride?.required ?? false);
    if (!needed) continue;
    const adapter = adapterFor(pkg.test.adapter);
    const candidateFiles = [...new Set(pkgCandidates.flatMap((c) => c.testFiles))];
    const { argv, scoped } = adapter.buildArgv(pkg.test.argv, rebaseToCwd(candidateFiles, pkg.test.cwd));
    if (!scoped) {
      diagnostics.push(
        `package "${pkg.id}" argv is not file-scopable; running the full configured test argv (impact candidates still recorded)`
      );
    }
    const stepId = `targeted-test:${pkg.id}`;
    steps.push({
      id: stepId,
      tier: "targeted-test",
      required: checkOverride?.required ?? true,
      adapterId: adapter.id,
      argv,
      cwd: pkg.test.cwd,
      timeoutMs: pkg.test.timeoutMs,
      expectedArtifacts: [pkg.test.coverageFile],
      dependsOn: cheapStepIds,
      rationale: [
        `impact candidates for package "${pkg.id}": ${pkgCandidates.map((c) => `${c.id} (${c.confidence})`).join("; ") || "configured required check"}`,
        `expected artifact: ${pkg.test.coverageFile}`
      ]
    });
    targetedStepIds.push(stepId);
  }

  // tier 3 (analysis): changed-line coverage parse — no process, artifact only
  for (const pkg of config.packages) {
    if (!packagesWithCandidates.has(pkg.id) && !targetedStepIds.includes(`targeted-test:${pkg.id}`)) continue;
    const adapter = adapterFor(pkg.test.adapter);
    steps.push({
      id: `changed-line-coverage:${pkg.id}`,
      tier: "changed-line-coverage",
      required: true,
      adapterId: adapter.coverageAdapter.id,
      argv: [],
      cwd: pkg.test.cwd,
      timeoutMs: 30_000,
      expectedArtifacts: [pkg.test.coverageFile],
      dependsOn: targetedStepIds,
      rationale: [`parse ${pkg.test.coverageFile} and intersect with changed executable lines`]
    });
  }

  if (steps.length === 0) {
    diagnostics.push("no steps planned: no changed files matched any package and no checks configured for this ChangeSet");
  }

  const planId = hash(
    canonicalJsonStringify({
      schemaVersion: "1.0",
      changeSetDigest: inputs.changeSetDigest,
      workspaceFingerprint: inputs.workspaceFingerprint,
      steps: steps.map((s) => ({ id: s.id, tier: s.tier, argv: s.argv, cwd: s.cwd })),
      candidates: candidates.map((c) => c.id)
    })
  );

  return {
    schemaVersion: "1.0",
    id: planId,
    changeSetDigest: inputs.changeSetDigest,
    workspaceFingerprint: inputs.workspaceFingerprint,
    candidates,
    steps,
    diagnostics
  };
}
