/**
 * 执行器：按依赖顺序跑计划步骤，argv-only 子进程、超时、取消、
 * 输出上限、产物解析（PROJECT.md 8.4）。纯解析步骤（changed-line-coverage）
 * 不启进程。
 */
import { randomUUID } from "node:crypto";
import { CpError } from "../../shared/errors.ts";
import type { Digest, EvidenceRecord, VerificationPlan, VerificationStep } from "../../shared/models.ts";
import type { SubprocessPort, ExecuteResult } from "../adapters/dsh/subprocess-port.ts";
import type { FsPort } from "../adapters/dsh/fs-port.ts";
import { sha256Hex } from "../adapters/dsh/fs-port.ts";
import type { CoverageAdapter, CoverageArtifact } from "../adapters/types.ts";
import { istanbulAdapter } from "../adapters/javascript/istanbul.ts";
import { coveragePyAdapter } from "../adapters/python/coverage-json.ts";
import { buildEnv, checkCommand, redactArgv } from "./command-policy.ts";
import { summarizeOutput, type OutputLimits } from "./output-limiter.ts";

export const DEFAULT_PARSE_CAPS = { maxFileEntries: 20_000, maxLinesPerFile: 200_000 };
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export interface ExecutorServices {
  subprocess: SubprocessPort;
  fs: FsPort;
  workspaceRootAbs: string;
  env: Record<string, string | undefined>;
  outputLimits: OutputLimits;
  abortSignal?: AbortSignal;
  /** Approval hook: receives the exact preview before ANY process runs. */
  approve?: (preview: {
    stepId: string;
    argv: string[];
    cwd: string;
    timeoutMs: number;
    envKeys: string[];
    expectedArtifacts: string[];
    riskLevel: "normal" | "high";
    warnings: string[];
  }) => Promise<boolean>;
}

export interface StepRunOutcome {
  step: VerificationStep;
  evidence: EvidenceRecord | null;
  error: string | null;
  /** Parsed coverage artifact for changed-line-coverage steps. */
  artifact: CoverageArtifact | null;
}

function coverageAdapterById(id: string): CoverageAdapter {
  if (id === istanbulAdapter.id) return istanbulAdapter;
  if (id === coveragePyAdapter.id) return coveragePyAdapter;
  throw new CpError("CP_COVERAGE_SCHEMA_UNKNOWN", `no coverage adapter registered for "${id}"`);
}

export async function executePlan(
  plan: VerificationPlan,
  services: ExecutorServices,
  context: { planId: string; changedFilesDigest: Digest; workspaceFingerprint: Digest; lockConfigDigest: Digest; startedAtIso: string }
): Promise<{ outcomes: StepRunOutcome[]; cancelled: boolean }> {
  const executed = new Set<string>();
  const outcomes: StepRunOutcome[] = [];
  let cancelled = false;

  const readySteps = () => plan.steps.filter((s) => !executed.has(s.id) && s.dependsOn.every((d) => executed.has(d)));

  while (executed.size < plan.steps.length) {
    if (services.abortSignal?.aborted) {
      cancelled = true;
      break;
    }
    const batch = readySteps();
    if (batch.length === 0) {
      // dependency cycle or blocked: mark remaining as not executed
      for (const s of plan.steps.filter((x) => !executed.has(x.id))) {
        outcomes.push({ step: s, evidence: null, error: "dependency not satisfied (upstream failure or cycle)", artifact: null });
        executed.add(s.id);
      }
      break;
    }
    for (const step of batch) {
      if (services.abortSignal?.aborted) {
        cancelled = true;
        break;
      }
      const outcome = await runStep(step, plan, services, context);
      outcomes.push(outcome);
      executed.add(step.id);
    }
    if (cancelled) {
      for (const s of plan.steps.filter((x) => !executed.has(x.id))) {
        outcomes.push({ step: s, evidence: null, error: "cancelled", artifact: null });
        executed.add(s.id);
      }
      break;
    }
  }

  return { outcomes, cancelled };
}

async function runStep(
  step: VerificationStep,
  plan: VerificationPlan,
  services: ExecutorServices,
  context: { planId: string; changedFilesDigest: Digest; workspaceFingerprint: Digest; lockConfigDigest: Digest; startedAtIso: string }
): Promise<StepRunOutcome> {
  const id = `ev-${randomUUID().slice(0, 8)}`;
  const base = {
    schemaVersion: "1.0" as const,
    id,
    planId: plan.id,
    stepId: step.id,
    cwd: step.cwd,
    startedAt: new Date().toISOString(),
    changedFilesDigest: context.changedFilesDigest,
    workspaceFingerprint: context.workspaceFingerprint,
    lockConfigDigest: context.lockConfigDigest
  };

  // parse-only step: changed-line coverage
  if (step.tier === "changed-line-coverage") {
    return parseArtifactStep(step, base, services);
  }

  try {
    const preview = checkCommand({
      argv: step.argv,
      cwdRel: step.cwd,
      timeoutMs: step.timeoutMs,
      expectedArtifacts: step.expectedArtifacts
    });
    if (services.approve) {
      const ok = await services.approve({ stepId: step.id, ...preview });
      if (!ok) {
        return {
          step,
          evidence: {
            ...base,
            adapter: { id: step.adapterId, version: "1.0" },
            argvRedacted: redactArgv(step.argv),
            durationMs: 0,
            exitCode: null,
            termination: "cancelled",
            artifactDigests: [],
            parser: { status: "not-applicable", diagnostics: ["approval denied"] },
            outputDigest: `sha256:${"0".repeat(64)}` as Digest
          },
          error: "approval denied",
          artifact: null
        };
      }
    }

    // TOCTOU re-check: resolve cwd inside the workspace right before spawn
    let cwdAbs: string;
    try {
      cwdAbs = step.cwd === "" ? services.workspaceRootAbs : await services.fs.realpathInWorkspace(services.workspaceRootAbs, step.cwd);
    } catch (err) {
      const message = err instanceof CpError ? err.message : String(err);
      return { step, evidence: null, error: `cwd rejected: ${message}`, artifact: null };
    }

    const started = Date.now();
    let result: ExecuteResult;
    try {
      result = await services.subprocess.execute({
        argv: step.argv,
        cwdAbs,
        timeoutMs: step.timeoutMs,
        maxOutputBytes: services.outputLimits.maxBytes,
        env: buildEnv(services.env),
        abortSignal: services.abortSignal
      });
    } catch (err) {
      // policy rejection before spawn
      const message = err instanceof Error ? err.message : String(err);
      return { step, evidence: null, error: message, artifact: null };
    }
    const durationMs = Date.now() - started;
    const output = result.stdout + (result.stderr.length > 0 ? "\n--stderr--\n" + result.stderr : "");
    const { summary, digest } = summarizeOutput(output, services.outputLimits);

    return {
      step,
      evidence: {
        ...base,
        adapter: { id: step.adapterId, version: "1.0" },
        argvRedacted: redactArgv(step.argv),
        durationMs,
        exitCode: result.exitCode,
        termination: result.termination,
        artifactDigests: [],
        parser: { status: "not-applicable", diagnostics: [] },
        outputDigest: digest,
        outputSummary: summary
      },
      error: null,
      artifact: null
    };
  } catch (err) {
    return { step, evidence: null, error: err instanceof Error ? err.message : String(err), artifact: null };
  }
}

async function parseArtifactStep(
  step: VerificationStep,
  base: Omit<EvidenceRecord, "adapter" | "argvRedacted" | "durationMs" | "exitCode" | "termination" | "artifactDigests" | "parser" | "outputDigest">,
  services: ExecutorServices
): Promise<StepRunOutcome> {
  const adapter = coverageAdapterById(step.adapterId);
  const artifactRel = step.expectedArtifacts[0] ?? "";
  const started = Date.now();
  try {
    const artifactAbs = await services.fs.realpathInWorkspace(services.workspaceRootAbs, artifactRel);
    const { bytes, truncated } = await services.fs.readFileBounded(artifactAbs, MAX_ARTIFACT_BYTES);
    if (truncated) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${artifactRel}`);
    }
    const text = Buffer.from(bytes).toString("utf8");
    const artifact = adapter.parse(text, { workspaceRootAbs: services.workspaceRootAbs, ...DEFAULT_PARSE_CAPS });
    const evidence: EvidenceRecord = {
      ...base,
      adapter: { id: adapter.id, version: adapter.version },
      argvRedacted: [],
      durationMs: Date.now() - started,
      exitCode: 0,
      termination: "exit",
      artifactDigests: [{ kind: adapter.artifactKind, digest: sha256Hex(text) }],
      parser: { status: "ok", diagnostics: artifact.diagnostics },
      outputDigest: `sha256:${"0".repeat(64)}` as Digest,
      coverage: { coverableChangedLines: 0, coveredChangedLines: 0, ratio: null, uncovered: [] }
    };
    return { step, evidence, error: null, artifact };
  } catch (err) {
    const message = err instanceof CpError ? `${err.code}: ${err.message}` : String(err);
    const evidence: EvidenceRecord = {
      ...base,
      adapter: { id: adapter.id, version: adapter.version },
      argvRedacted: [],
      durationMs: Date.now() - started,
      exitCode: null,
      termination: "exit",
      artifactDigests: [],
      parser: { status: "error", diagnostics: [message] },
      outputDigest: `sha256:${"0".repeat(64)}` as Digest
    };
    return { step, evidence, error: null, artifact: null }; // parser error is EVIDENCE (fail loud in verdict), not a thrown error
  }
}
