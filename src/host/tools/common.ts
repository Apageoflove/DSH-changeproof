/**
 * 三个工具共用的分析流程：加载配置 → 变更集 → 扫描 → impact → 指纹。
 * 纯编排，这里不运行任何项目代码。
 */
import type { ChangeProofToolResult, Diagnostic } from "../../shared/result.ts";
import type { Digest } from "../../shared/models.ts";
import type { HostContext } from "../adapters/dsh/compatibility-facade.ts";
import { sha256Hex } from "../adapters/dsh/fs-port.ts";
import { buildChangeSet } from "../adapters/git/changeset.ts";
import { loadConfig, type ChangeProofConfig } from "../config/load.ts";
import { resolveImpact } from "../analysis/impact-resolver.ts";
import { computeFingerprint } from "../analysis/fingerprint.ts";
import { gatherFingerprintInputs, makeGitRunner, prewarmReader, scanWorkspaceFiles, workspaceIdOf } from "../workspace.ts";
import type { ChangeSet, ImpactCandidate } from "../../shared/models.ts";
import { CpError } from "../../shared/errors.ts";
import { errorResult } from "../../shared/result.ts";
import type { HashFn } from "../analysis/fingerprint.ts";

export const ADAPTER_VERSIONS = [
  { id: "istanbul", version: "1.0" },
  { id: "coverage-py", version: "1.0" }
];

export interface AnalysisSnapshot {
  config: ChangeProofConfig;
  changeSet: ChangeSet;
  workspaceFiles: string[];
  scanTruncated: boolean;
  candidates: ImpactCandidate[];
  maxConfidence: "HIGH" | "MEDIUM" | "LOW";
  impactDiagnostics: string[];
  fingerprint: Digest;
}

export interface AnalyzeOptions {
  baselineKind?: "head" | "merge-base";
  mergeBaseRef?: string;
}

export async function analyzeWorkspace(
  host: HostContext,
  workspaceRootAbs: string,
  options: AnalyzeOptions = {}
): Promise<AnalysisSnapshot> {
  const { fs } = host;
  const config = await loadConfig(fs, workspaceRootAbs);
  const workspaceId = await workspaceIdOf(fs, workspaceRootAbs);
  const runGit = makeGitRunner(host.subprocess, process.env);

  const changeSet = await buildChangeSet({
    workspaceRootAbs,
    untrackedIncludeGlobs: config.packages.flatMap((p) => p.include),
    baselineKind: options.baselineKind ?? config.baseline.kind,
    mergeBaseRef: options.mergeBaseRef ?? config.baseline.ref,
    runGit,
    digestFile: async (abs): Promise<Digest | null> => {
      try {
        return await fs.digestFileNormalized(abs, 20 * 1024 * 1024);
      } catch {
        return null;
      }
    },
    workspaceId,
    hashCanonical: sha256Hex
  });

  const scan = await scanWorkspaceFiles(fs, workspaceRootAbs, config);
  const reader = await prewarmReader(fs, workspaceRootAbs, scan.files);
  const impact = resolveImpact({
    changedFiles: changeSet.files.map((f) => ({ path: f.path, contentDigest: f.contentDigest })),
    workspaceFiles: scan.files,
    readWorkspaceFile: reader,
    config,
    historyEntries: [],
    nowIso: new Date().toISOString()
  });

  const fpInputs = await gatherFingerprintInputs(fs, workspaceRootAbs, config, changeSet, impact.candidates, ADAPTER_VERSIONS, scan.files);
  const fingerprint = computeFingerprint(fpInputs, sha256Hex);

  return {
    config,
    changeSet,
    workspaceFiles: scan.files,
    scanTruncated: scan.truncated,
    candidates: impact.candidates,
    maxConfidence: impact.maxConfidence,
    impactDiagnostics: impact.diagnostics,
    fingerprint
  };
}

export function diagnosticsFromSnapshot(snap: AnalysisSnapshot): Diagnostic[] {
  return [
    ...snap.changeSet.diagnostics.map((message) => ({ severity: "info" as const, code: "CP_CHANGESET_INFO", message })),
    ...snap.impactDiagnostics.map((message) => ({ severity: "info" as const, code: "CP_IMPACT_INFO", message })),
    ...(snap.scanTruncated ? [{ severity: "warning" as const, code: "CP_SCAN_TRUNCATED", message: "workspace scan hit the file cap; impact may be incomplete" }] : [])
  ];
}

export function toolError(kind: "changeproof_plan" | "changeproof_verify" | "changeproof_status", err: unknown): ChangeProofToolResult<never> {
  if (err instanceof CpError) {
    return errorResult(kind, err.code, err.message, err.details);
  }
  return errorResult(kind, "CP_INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}
