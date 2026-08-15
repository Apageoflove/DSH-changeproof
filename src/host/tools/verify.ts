/**
 * `changeproof_verify` tool: pre-fingerprint → execute layers (approval
 * hook, timeout, cancel) → parse artifacts → post-fingerprint → verdict →
 * persist evidence (PROJECT.md 9.1).
 */
import type { ChangeProofToolResult } from "../../shared/result.ts";
import { okResult } from "../../shared/result.ts";
import type { Verdict, EvidenceRecord, Digest } from "../../shared/models.ts";
import { globMatch } from "../../shared/schema.ts";
import type { HostContext } from "../adapters/dsh/compatibility-facade.ts";
import { sha256Hex } from "../adapters/dsh/fs-port.ts";
import { analyzeWorkspace, diagnosticsFromSnapshot, toolError, type AnalyzeOptions } from "./common.ts";
import { buildPlan } from "../execution/planner.ts";
import { executePlan } from "../execution/executor.ts";
import { analyzeChangedLineCoverage, isDeletionOnly } from "../analysis/changed-lines.ts";
import { evaluateVerdict, type CheckOutcome, type VerdictPolicy } from "../analysis/verdict.ts";
import { verdictPolicyFromConfig } from "../config/defaults.ts";
import { DEFAULT_OUTPUT_LIMITS } from "../config/defaults.ts";
import { gatherFingerprintInputs } from "../workspace.ts";
import { EvidenceStore } from "../persistence/evidence-store.ts";
import { JsonHistoryMapStore } from "../persistence/coverage-map-store.ts";
import type { PlanData } from "./plan.ts";
import { deletedLineRiskOf } from "../analysis/deletion-risk.ts";
import path from "node:path";

export interface VerifyOptions extends AnalyzeOptions {
  abortSignal?: AbortSignal;
  approve?: Parameters<typeof executePlan>[1]["approve"];
}

export interface VerifyData {
  plan: PlanData;
  evidence: EvidenceRecord[];
  verdict: Verdict;
  coverageByFile: ReturnType<typeof analyzeChangedLineCoverage>["files"];
  changedLineCoverageSummary: {
    coverableTotal: number;
    coveredTotal: number;
    uncoveredTotal: number;
    ratio: number | null;
    gapFiles: string[];
    excludedFiles: Array<{ path: string; rule: string }>;
  };
  workspaceChangedDuringRun: boolean;
}

export async function verifyTool(
  host: HostContext,
  workspaceRootAbs: string,
  options: VerifyOptions = {}
): Promise<ChangeProofToolResult<VerifyData>> {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const plan = buildPlan(
      {
        config: snap.config,
        candidates: snap.candidates,
        changeSetDigest: snap.changeSet.digest,
        workspaceFingerprint: snap.fingerprint,
        nowIso: new Date().toISOString()
      },
      sha256Hex
    );

    const changedFilesDigest = snap.changeSet.digest;
    const lockConfigDigest: Digest = sha256Hex(
      JSON.stringify([...(await gatherFingerprintInputs(host.fs, workspaceRootAbs, snap.config, snap.changeSet, snap.candidates, [], snap.workspaceFiles)).lockfileDigests])
    );

    // PRE-execution fingerprint is snap.fingerprint (computed before any step runs)
    const { outcomes } = await executePlan(
      plan,
      {
        subprocess: host.subprocess,
        fs: host.fs,
        workspaceRootAbs,
        env: process.env,
        outputLimits: DEFAULT_OUTPUT_LIMITS,
        abortSignal: options.abortSignal,
        approve: options.approve
      },
      {
        planId: plan.id,
        changedFilesDigest,
        workspaceFingerprint: snap.fingerprint,
        lockConfigDigest,
        startedAtIso: new Date().toISOString()
      }
    );

    // POST-execution fingerprint: workspace must be unchanged by the run itself
    const postSnap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const workspaceChangedDuringRun = postSnap.fingerprint !== snap.fingerprint;

    // fold parsed artifacts into coverage analysis
    const executableByFile = new Map<string, Set<number>>();
    const coveredByFile = new Map<string, Set<number>>();
    let coverageParseError = false;
    for (const o of outcomes) {
      if (o.artifact && o.evidence) {
        for (const [p, lines] of o.artifact.executableByFile) executableByFile.set(p, lines);
        for (const [p, lines] of o.artifact.coveredByFile) coveredByFile.set(p, lines);
        if (o.evidence.parser.status === "error") coverageParseError = true;
      }
      if (o.evidence?.parser.status === "error") coverageParseError = true;
    }
    const coverage = analyzeChangedLineCoverage(snap.changeSet, executableByFile, coveredByFile, snap.config.exclude);

    // stamp coverage numbers onto parse-step evidence
    for (const o of outcomes) {
      if (o.step.tier === "changed-line-coverage" && o.evidence) {
        if (workspaceChangedDuringRun) o.evidence.workspaceChangedDuringRun = true;
        o.evidence.coverage = {
          coverableChangedLines: coverage.coverableTotal,
          coveredChangedLines: coverage.coveredTotal,
          ratio: coverage.ratio,
          uncovered: coverage.files.filter((f) => f.uncovered.length > 0).map((f) => ({ path: f.path, lines: f.uncovered }))
        };
      }
    }

    const evidence = outcomes.map((o) => o.evidence).filter((e): e is EvidenceRecord => e !== null);
    const evidenceByStep = new Map(evidence.map((e) => [e.stepId, e]));

    // required checks: configured checks + targeted-test steps + coverage steps
    const checks: CheckOutcome[] = [];
    for (const step of plan.steps) {
      if (!step.required) continue;
      checks.push({ id: step.id, required: true, evidence: evidenceByStep.get(step.id) ?? null });
    }

    const policy: VerdictPolicy = verdictPolicyFromConfig(snap.config);
    const contentChangesAllExcluded =
      snap.changeSet.files.length > 0 &&
      snap.changeSet.files.every(
        (f) =>
          f.status === "deleted" ||
          f.ranges.every((r) => r.kind === "deleted") ||
          snap.config.exclude.some((g: string) => globMatch(g, f.path))
      );
    const verdict = evaluateVerdict(
      {
        currentFingerprint: snap.fingerprint,
        changeSetMode: snap.changeSet.mode,
        changeSetParseError: false,
        deletionOnly: isDeletionOnly(snap.changeSet.files),
        contentChangesAllExcluded,
        impactMaxConfidence: snap.maxConfidence,
        coverage,
        coverageParseError,
        checks,
        policy
      },
      new Date().toISOString()
    );

    // persist evidence (minimal, no secrets)
    const store = new EvidenceStore(path.join(workspaceRootAbs, ".changeproof", "evidence"));
    for (const e of evidence) {
      if (workspaceChangedDuringRun) e.workspaceChangedDuringRun = true;
      await store.append(e);
    }

    // persist history map entries for verified artifacts (tier-2 source)
    if (snap.config.coverage.historyMap.enabled && coverageParseError === false) {
      const historyStore = new JsonHistoryMapStore(path.join(workspaceRootAbs, ".changeproof", "coverage-map.json"));
      const entries = await historyStore.load();
      for (const cand of snap.candidates) {
        for (const src of cand.affectedFiles) {
          const file = snap.changeSet.files.find((f) => f.path === src);
          entries.push({
            path: src,
            contentDigest: file?.contentDigest ?? `sha256:${"0".repeat(64)}`,
            testFiles: cand.testFiles,
            adapter: { id: "istanbul", version: "1.0" },
            recordedAt: new Date().toISOString()
          });
        }
      }
      // keep newest entry per path
      const byPath = new Map(entries.map((e) => [e.path, e]));
      await historyStore.save([...byPath.values()]);
    }

    const planData: PlanData = {
      changeSetSummary: {
        mode: snap.changeSet.mode,
        baseline: snap.changeSet.baseline,
        files: snap.changeSet.files.map((f) => ({ path: f.path, status: f.status, linesAdded: f.linesAdded, linesDeleted: f.linesDeleted })),
        deletedLineRisk: deletedLineRiskOf(snap.changeSet.files),
        digest: snap.changeSet.digest
      },
      impact: { candidates: plan.candidates, maxConfidence: snap.maxConfidence },
      steps: plan.steps,
      preview: plan.steps
        .filter((s) => s.argv.length > 0)
        .map((s) => ({ stepId: s.id, argv: s.argv, cwd: s.cwd, timeoutMs: s.timeoutMs, expectedArtifacts: s.expectedArtifacts })),
      planId: plan.id,
      workspaceFingerprint: snap.fingerprint
    };

    return okResult(
      "changeproof_verify",
      {
        plan: planData,
        evidence,
        verdict,
        coverageByFile: coverage.files,
        changedLineCoverageSummary: {
          coverableTotal: coverage.coverableTotal,
          coveredTotal: coverage.coveredTotal,
          uncoveredTotal: coverage.uncoveredTotal,
          ratio: coverage.ratio,
          gapFiles: coverage.gapFiles,
          excludedFiles: coverage.excludedFiles
        },
        workspaceChangedDuringRun
      },
      diagnosticsFromSnapshot(snap)
    );
  } catch (err) {
    return toolError("changeproof_verify", err);
  }
}
