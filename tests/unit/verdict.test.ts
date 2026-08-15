import { describe, expect, it } from "vitest";
import { evaluateVerdict, type CheckOutcome, type VerdictInputs } from "@host/analysis/verdict.js";
import type { Digest, EvidenceRecord } from "@shared/models.js";

const FP: Digest = "sha256:current";
const OTHER_FP: Digest = "sha256:older";

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schemaVersion: "1.0",
    id: "ev-1",
    planId: "plan-1",
    stepId: "step-tests",
    adapter: { id: "istanbul", version: "1.0" },
    argvRedacted: ["vitest", "run"],
    cwd: "packages/web",
    startedAt: "2026-08-14T00:00:00.000Z",
    durationMs: 1000,
    exitCode: 0,
    termination: "exit",
    changedFilesDigest: "sha256:cf",
    workspaceFingerprint: FP,
    lockConfigDigest: "sha256:lc",
    artifactDigests: [],
    parser: { status: "ok", diagnostics: [] },
    outputDigest: "sha256:out",
    ...overrides
  };
}

function inputs(overrides: Partial<VerdictInputs> = {}): VerdictInputs {
  return {
    currentFingerprint: FP,
    changeSetMode: "git",
    changeSetParseError: false,
    deletionOnly: false,
    contentChangesAllExcluded: false,
    impactMaxConfidence: "HIGH",
    coverage: {
      files: [
        {
          path: "src/billing.ts",
          coverable: [10, 11, 12, 13],
          covered: [10, 11, 12, 13],
          uncovered: [],
          absentFromArtifact: false
        }
      ],
      coverableTotal: 4,
      coveredTotal: 4,
      uncoveredTotal: 0,
      ratio: 1.0,
      gapFiles: [],
      excludedFiles: []
    },
    coverageParseError: false,
    checks: [{ id: "tests", required: true, evidence: evidence() }],
    policy: {
      changedLinesThreshold: 1.0,
      requiresExhaustiveImpact: true,
      minimumImpactConfidence: "MEDIUM",
      deletionOnlyPolicy: "PARTIAL"
    },
    ...overrides
  };
}

describe("verdict state machine (PROJECT.md 17.2 matrix)", () => {
  it("VERIFIED: fresh evidence + all required checks green + coverage at threshold", () => {
    const v = evaluateVerdict(inputs(), "2026-08-14T00:00:01.000Z");
    expect(v.status).toBe("VERIFIED");
    expect(v.changedLineCoverage).toEqual({ threshold: 1.0, actual: 1.0 });
    expect(v.requiredChecks[0]!.status).toBe("VERIFIED");
  });

  it("STALE: evidence bound to an older fingerprint", () => {
    const v = evaluateVerdict(
      inputs({ checks: [{ id: "tests", required: true, evidence: evidence({ workspaceFingerprint: OTHER_FP }) }] }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("STALE");
    expect(v.reasons[0]!.code).toBe("CP_FINGERPRINT_MISMATCH");
  });

  it("STALE even when workspace changed during the run with exit 0", () => {
    const v = evaluateVerdict(
      inputs({ checks: [{ id: "tests", required: true, evidence: evidence({ workspaceChangedDuringRun: true }) }] }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("STALE");
    expect(v.reasons[0]!.code).toBe("CP_WORKSPACE_CHANGED_DURING_VERIFY");
  });

  it("FAILED: required test assertion failure", () => {
    const v = evaluateVerdict(
      inputs({ checks: [{ id: "tests", required: true, evidence: evidence({ exitCode: 1 }) }] }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("FAILED");
    expect(v.reasons[0]!.code).toBe("CP_REQUIRED_CHECK_FAILED");
  });

  it("FAILED: timeout and cancelled are failures too", () => {
    for (const termination of ["timeout", "cancelled"] as const) {
      const v = evaluateVerdict(
        inputs({ checks: [{ id: "tests", required: true, evidence: evidence({ termination, exitCode: null }) }] }),
        "2026-08-14T00:00:01.000Z"
      );
      expect(v.status).toBe("FAILED");
    }
  });

  it("UNVERIFIED: non-Git workspace never VERIFIED", () => {
    const v = evaluateVerdict(inputs({ changeSetMode: "degraded" }), "2026-08-14T00:00:01.000Z");
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_NO_GIT_CHANGESET");
  });

  it("UNVERIFIED: required evidence missing (only unrelated green tests are NOT evidence)", () => {
    const v = evaluateVerdict(
      inputs({ checks: [{ id: "tests", required: true, evidence: null }] }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_EVIDENCE_UNAVAILABLE");
  });

  it("UNVERIFIED: coverage artifact missing even with exit 0", () => {
    const v = evaluateVerdict(inputs({ coverage: null }), "2026-08-14T00:00:01.000Z");
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_COVERAGE_ARTIFACT_MISSING");
  });

  it("UNVERIFIED: coverage parser error", () => {
    const v = evaluateVerdict(
      inputs({
        coverageParseError: true,
        checks: [{ id: "tests", required: true, evidence: evidence({ parser: { status: "error", diagnostics: ["bad schema"] } }) }]
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_COVERAGE_PARSE_ERROR");
  });

  it("UNVERIFIED: LOW-only impact with exhaustive requirement", () => {
    const v = evaluateVerdict(inputs({ impactMaxConfidence: "LOW" }), "2026-08-14T00:00:01.000Z");
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_IMPACT_LOW_CONFIDENCE");
  });

  it("PARTIAL: coverage below threshold but trustworthy evidence exists", () => {
    const v = evaluateVerdict(
      inputs({
        coverage: {
          files: [
            { path: "src/billing.ts", coverable: [10, 11, 12, 13, 14], covered: [10, 11], uncovered: [12, 13, 14], absentFromArtifact: false }
          ],
          coverableTotal: 5,
          coveredTotal: 2,
          uncoveredTotal: 3,
          ratio: 0.4,
          gapFiles: [],
          excludedFiles: []
        }
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("PARTIAL");
    expect(v.reasons.some((r) => r.code === "CP_COVERAGE_BELOW_THRESHOLD")).toBe(true);
  });

  it("PARTIAL: deleted-only ChangeSet stays PARTIAL by default (deletion risk)", () => {
    const v = evaluateVerdict(
      inputs({
        deletionOnly: true,
        coverage: { files: [], coverableTotal: 0, coveredTotal: 0, uncoveredTotal: 0, ratio: null, gapFiles: [], excludedFiles: [] }
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("PARTIAL");
    expect(v.reasons[0]!.code).toBe("CP_DELETION_ONLY_RISK");
  });

  it("NOT_APPLICABLE: zero executable changed lines with no gaps carries a reason code", () => {
    const v = evaluateVerdict(
      inputs({
        coverage: { files: [], coverableTotal: 0, coveredTotal: 0, uncoveredTotal: 0, ratio: null, gapFiles: [], excludedFiles: [] }
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("NOT_APPLICABLE");
    expect(v.reasons[0]!.code).toBe("CP_NOT_APPLICABLE_NO_EXECUTABLE_CHANGES");
  });

  it("UNVERIFIED (not NOT_APPLICABLE): changed file absent from coverage artifact is a gap", () => {
    const v = evaluateVerdict(
      inputs({
        coverage: {
          files: [{ path: "src/secret.ts", coverable: [], covered: [], uncovered: [], absentFromArtifact: true }],
          coverableTotal: 0,
          coveredTotal: 0,
          uncoveredTotal: 0,
          ratio: null,
          gapFiles: ["src/secret.ts"],
          excludedFiles: []
        }
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_COVERAGE_GAP_FILES");
  });

  it("spawn-error yields UNVERIFIED, never FAILED or VERIFIED", () => {
    const v = evaluateVerdict(
      inputs({ checks: [{ id: "tests", required: true, evidence: evidence({ termination: "spawn-error", exitCode: null }) }] }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("UNVERIFIED");
    expect(v.reasons[0]!.code).toBe("CP_SPAWN_ERROR");
  });

  it("priority: STALE wins over FAILED when both apply", () => {
    const v = evaluateVerdict(
      inputs({
        checks: [{ id: "tests", required: true, evidence: evidence({ workspaceFingerprint: OTHER_FP, exitCode: 1 }) }]
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("STALE");
  });

  it("threshold 0.5 allows VERIFIED at 60% coverage", () => {
    const v = evaluateVerdict(
      inputs({
        coverage: {
          files: [
            { path: "src/a.ts", coverable: [1, 2, 3, 4, 5], covered: [1, 2, 3], uncovered: [4, 5], absentFromArtifact: false }
          ],
          coverableTotal: 5,
          coveredTotal: 3,
          uncoveredTotal: 2,
          ratio: 0.6,
          gapFiles: [],
          excludedFiles: []
        },
        policy: { changedLinesThreshold: 0.5, requiresExhaustiveImpact: true, minimumImpactConfidence: "MEDIUM", deletionOnlyPolicy: "PARTIAL" }
      }),
      "2026-08-14T00:00:01.000Z"
    );
    expect(v.status).toBe("VERIFIED");
  });
});
