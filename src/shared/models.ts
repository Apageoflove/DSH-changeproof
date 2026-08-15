/**
 * Core data models (PROJECT.md section 11).
 * Everything here must be JSON-serializable; no Node-only imports.
 */

export type Digest = `sha256:${string}`;
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ChangedRange {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  kind: "added" | "modified" | "deleted";
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string; // workspace-relative, POSIX separators
  status: FileStatus;
  oldPath?: string; // for renamed entries
  contentDigest: Digest | null; // sha256 of normalized (LF) current content; null when deleted
  ranges: ChangedRange[];
  /** Lines of this change that the language adapter considers executable. */
  coverableExecutableLines: number[];
  linesAdded: number;
  linesDeleted: number;
}

export interface ChangeSet {
  schemaVersion: "1.0";
  mode: "git" | "degraded";
  workspaceId: Digest;
  baseline: { kind: "head" | "merge-base"; commit: string | null };
  files: ChangedFile[];
  digest: Digest;
  diagnostics: string[];
}

export type ImpactSource = "explicit" | "coverage-history" | "import-graph" | "naming";

export interface ImpactCandidate {
  schemaVersion: "1.0";
  id: string;
  packageId: string;
  testFiles: string[];
  argv: string[];
  cwd: string; // workspace-relative
  source: ImpactSource;
  confidence: Confidence;
  affectedFiles: string[];
  rationale: string[];
  excludedReason?: string;
}

export type VerificationTier = "cheap" | "targeted-test" | "changed-line-coverage" | "mutation-smoke";

export interface VerificationStep {
  id: string;
  tier: VerificationTier;
  required: boolean;
  adapterId: string;
  argv: string[];
  cwd: string; // workspace-relative
  timeoutMs: number;
  expectedArtifacts: string[]; // workspace-relative
  dependsOn: string[];
  rationale?: string[];
}

export interface VerificationPlan {
  schemaVersion: "1.0";
  id: string;
  changeSetDigest: Digest;
  workspaceFingerprint: Digest;
  candidates: ImpactCandidate[];
  steps: VerificationStep[];
  diagnostics: string[];
}

export interface ArtifactDigest {
  kind: string; // e.g. "istanbul-json" | "coverage-py-json" | "stdout"
  digest: Digest;
}

export type Termination = "exit" | "timeout" | "cancelled" | "spawn-error";

export interface EvidenceCoverage {
  coverableChangedLines: number;
  coveredChangedLines: number;
  ratio: number | null;
  uncovered: Array<{ path: string; lines: number[] }>;
}

export interface EvidenceRecord {
  schemaVersion: "1.0";
  id: string;
  planId: string;
  stepId: string;
  adapter: { id: string; version: string };
  argvRedacted: string[];
  cwd: string;
  startedAt: string; // ISO-8601 UTC
  durationMs: number;
  exitCode: number | null;
  termination: Termination;
  changedFilesDigest: Digest;
  workspaceFingerprint: Digest;
  lockConfigDigest: Digest;
  artifactDigests: ArtifactDigest[];
  parser: { status: "ok" | "error" | "not-applicable"; diagnostics: string[] };
  coverage?: EvidenceCoverage;
  outputDigest: Digest;
  outputSummary?: { truncated: boolean; headLines: string[]; tailLines: string[] };
  /** True when the workspace fingerprint changed between pre/post execution scan. */
  workspaceChangedDuringRun?: boolean;
}

export interface VerdictReason {
  code: string;
  message: string;
  blocking: boolean;
}

export interface RequiredCheckStatus {
  id: string;
  status: import("./status.ts").VerdictStatus;
  evidenceId?: string;
}

export interface Verdict {
  schemaVersion: "1.0";
  status: import("./status.ts").VerdictStatus;
  workspaceFingerprint: Digest;
  evaluatedAt: string; // ISO-8601 UTC
  reasons: VerdictReason[];
  requiredChecks: RequiredCheckStatus[];
  changedLineCoverage: { threshold: number; actual: number | null };
}

/** Inputs that feed the workspace fingerprint (PROJECT.md 8.6). */
export interface FingerprintInputs {
  baselineCommit: string | null;
  changeSetDigest: Digest;
  changedFileDigests: Array<{ path: string; digest: Digest | null }>;
  testFileDigests: Array<{ path: string; digest: Digest | null }>;
  lockfileDigests: Array<{ path: string; digest: Digest }>;
  runnerConfigDigests: Array<{ path: string; digest: Digest }>;
  pluginConfigDigest: Digest | null;
  adapters: Array<{ id: string; version: string }>;
}

/** Coverage per changed file, used by verdict and UI. */
export interface FileCoverage {
  path: string;
  coverable: number[]; // executable changed lines
  covered: number[];
  uncovered: number[];
  absentFromArtifact: boolean; // file not present in coverage artifact at all
  excluded?: string; // exclusion rule that removed it from the denominator
}
