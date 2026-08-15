/**
 * Verdict state machine (PROJECT.md 7 and 8.8).
 * Priority: STALE → FAILED → UNVERIFIED(cause) → PARTIAL → VERIFIED.
 * `NOT_APPLICABLE` only via deterministic rules with a reason code.
 *
 * HARD RULES (non-negotiable):
 *  - exit 0 without coverage artifact / with parser error / low-confidence
 *    mapping NEVER yields VERIFIED;
 *  - non-Git workspaces NEVER yield VERIFIED;
 *  - evidence bound to another fingerprint is STALE even if commands passed.
 */
import type {
  Confidence,
  Digest,
  EvidenceRecord,
  RequiredCheckStatus,
  Verdict,
  VerdictReason
} from "../../shared/models.ts";
import type { VerdictStatus } from "../../shared/status.ts";
import { isDeletionOnly, type ChangedLinesResult } from "./changed-lines.ts";

export interface CheckOutcome {
  id: string;
  required: boolean;
  evidence: EvidenceRecord | null;
}

export interface VerdictPolicy {
  changedLinesThreshold: number; // [0,1]
  /** When true, LOW-only impact forbids VERIFIED (exhaustive requirement). */
  requiresExhaustiveImpact: boolean;
  minimumImpactConfidence: Confidence;
  /** Deletion-only changesets default to PARTIAL (open question #5). */
  deletionOnlyPolicy: "PARTIAL" | "NOT_APPLICABLE";
}

export interface VerdictInputs {
  currentFingerprint: Digest;
  changeSetMode: "git" | "degraded";
  changeSetParseError: boolean;
  /** True when the ChangeSet contains only deletions. */
  deletionOnly: boolean;
  /**
   * True when every non-deleted change is excluded by config exclude rules
   * (e.g. only generated files changed): impact resolution is not required
   * and the coverage check is NOT_APPLICABLE instead of LOW-blocked.
   */
  contentChangesAllExcluded: boolean;
  impactMaxConfidence: Confidence;
  coverage: ChangedLinesResult | null; // null = no coverage artifact parsed at all
  coverageParseError: boolean;
  checks: CheckOutcome[];
  policy: VerdictPolicy;
}

export const VERDICT_REASONS = {
  FINGERPRINT_MISMATCH: "CP_FINGERPRINT_MISMATCH",
  WORKSPACE_CHANGED_DURING_VERIFY: "CP_WORKSPACE_CHANGED_DURING_VERIFY",
  REQUIRED_CHECK_FAILED: "CP_REQUIRED_CHECK_FAILED",
  REQUIRED_CHECK_TIMEOUT: "CP_REQUIRED_CHECK_TIMEOUT",
  REQUIRED_CHECK_CANCELLED: "CP_REQUIRED_CHECK_CANCELLED",
  SPAWN_ERROR: "CP_SPAWN_ERROR",
  NO_GIT_CHANGESET: "CP_NO_GIT_CHANGESET",
  CHANGESET_UNAVAILABLE: "CP_CHANGESET_UNAVAILABLE",
  EVIDENCE_MISSING: "CP_EVIDENCE_UNAVAILABLE",
  COVERAGE_ARTIFACT_MISSING: "CP_COVERAGE_ARTIFACT_MISSING",
  COVERAGE_PARSE_ERROR: "CP_COVERAGE_PARSE_ERROR",
  IMPACT_LOW_CONFIDENCE: "CP_IMPACT_LOW_CONFIDENCE",
  COVERAGE_BELOW_THRESHOLD: "CP_COVERAGE_BELOW_THRESHOLD",
  COVERAGE_GAP_FILES: "CP_COVERAGE_GAP_FILES",
  DELETION_ONLY_RISK: "CP_DELETION_ONLY_RISK",
  PARTIAL_EVIDENCE: "CP_PARTIAL_EVIDENCE",
  NO_EVIDENCE: "CP_NO_EVIDENCE",
  NOT_APPLICABLE_NO_EXECUTABLE_CHANGES: "CP_NOT_APPLICABLE_NO_EXECUTABLE_CHANGES"
} as const;

function reason(code: string, message: string, blocking: boolean): VerdictReason {
  return { code, message, blocking };
}

export function evaluateVerdict(inputs: VerdictInputs, nowIso: string): Verdict {
  const reasons: VerdictReason[] = [];
  const requiredChecks: RequiredCheckStatus[] = [];
  const required = inputs.checks.filter((c) => c.required);
  const anyEvidence = inputs.checks.some((c) => c.evidence !== null);

  // helper: per-check status
  for (const c of required) {
    const ev = c.evidence;
    if (!ev) {
      requiredChecks.push({ id: c.id, status: "UNVERIFIED" });
      continue;
    }
    if (ev.workspaceChangedDuringRun) {
      requiredChecks.push({ id: c.id, status: "STALE", evidenceId: ev.id });
      continue;
    }
    if (ev.workspaceFingerprint !== inputs.currentFingerprint) {
      requiredChecks.push({ id: c.id, status: "STALE", evidenceId: ev.id });
      continue;
    }
    if (ev.termination !== "exit") {
      requiredChecks.push({
        id: c.id,
        status: ev.termination === "timeout" || ev.termination === "cancelled" ? "FAILED" : "UNVERIFIED",
        evidenceId: ev.id
      });
      continue;
    }
    if (ev.exitCode !== 0) {
      requiredChecks.push({ id: c.id, status: "FAILED", evidenceId: ev.id });
      continue;
    }
    if (ev.parser.status === "error") {
      requiredChecks.push({ id: c.id, status: "UNVERIFIED", evidenceId: ev.id });
      continue;
    }
    requiredChecks.push({ id: c.id, status: "VERIFIED", evidenceId: ev.id });
  }

  // 1. freshness first
  const staleEvidence = required.filter((c) => {
    const ev = c.evidence;
    return ev !== null && (ev.workspaceFingerprint !== inputs.currentFingerprint || ev.workspaceChangedDuringRun);
  });
  if (staleEvidence.length > 0) {
    const fromDuring = staleEvidence.some((c) => c.evidence!.workspaceChangedDuringRun);
    reasons.push(
      fromDuring
        ? reason(
            VERDICT_REASONS.WORKSPACE_CHANGED_DURING_VERIFY,
            `workspace changed during verification; evidence cannot be trusted even though commands may have exited 0: ${staleEvidence.map((c) => c.id).join(", ")}`,
            true
          )
        : reason(
            VERDICT_REASONS.FINGERPRINT_MISMATCH,
            `evidence bound to an older workspace fingerprint: ${staleEvidence.map((c) => c.id).join(", ")}`,
            true
          )
    );
    return build("STALE", inputs, reasons, requiredChecks, nowIso);
  }

  // 2. reliable failure
  const failed = required.filter((c) => {
    const ev = c.evidence;
    return (
      ev !== null &&
      ev.workspaceFingerprint === inputs.currentFingerprint &&
      ((ev.termination === "exit" && ev.exitCode !== null && ev.exitCode !== 0) ||
        ev.termination === "timeout" ||
        ev.termination === "cancelled")
    );
  });
  if (failed.length > 0) {
    for (const c of failed) {
      const ev = c.evidence!;
      const code =
        ev.termination === "timeout"
          ? VERDICT_REASONS.REQUIRED_CHECK_TIMEOUT
          : ev.termination === "cancelled"
            ? VERDICT_REASONS.REQUIRED_CHECK_CANCELLED
            : VERDICT_REASONS.REQUIRED_CHECK_FAILED;
      reasons.push(reason(code, `required check "${c.id}" ${ev.termination === "exit" ? `exited ${ev.exitCode ?? "unknown"}` : ev.termination}`, true));
    }
    return build("FAILED", inputs, reasons, requiredChecks, nowIso);
  }

  // spawn-error: evidence exists but execution never happened reliably
  const spawnErrored = required.filter((c) => c.evidence?.termination === "spawn-error");
  if (spawnErrored.length > 0) {
    reasons.push(reason(VERDICT_REASONS.SPAWN_ERROR, `required check could not start: ${spawnErrored.map((c) => c.id).join(", ")}`, true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // 3. non-Git / parse error
  if (inputs.changeSetMode !== "git" || inputs.changeSetParseError) {
    reasons.push(
      reason(
        inputs.changeSetParseError ? VERDICT_REASONS.CHANGESET_UNAVAILABLE : VERDICT_REASONS.NO_GIT_CHANGESET,
        inputs.changeSetParseError
          ? "change set could not be parsed reliably"
          : "workspace is not a usable Git repository; reliable ChangeSet unavailable",
        true
      )
    );
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // 4. missing required evidence / parser errors
  const missing = required.filter((c) => !c.evidence);
  const parseErrors = required.filter((c) => c.evidence?.parser.status === "error");
  if (missing.length > 0) {
    reasons.push(reason(VERDICT_REASONS.EVIDENCE_MISSING, `required evidence missing: ${missing.map((c) => c.id).join(", ")}`, true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverageParseError || parseErrors.length > 0) {
    reasons.push(
      reason(
        VERDICT_REASONS.COVERAGE_PARSE_ERROR,
        parseErrors.length > 0
          ? `coverage parser error: ${parseErrors.flatMap((c) => c.evidence!.parser.diagnostics).join("; ")}`
          : "coverage parser error",
        true
      )
    );
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverage === null) {
    reasons.push(reason(VERDICT_REASONS.COVERAGE_ARTIFACT_MISSING, "required coverage artifact missing (exit 0 alone proves nothing)", true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // 5. LOW-only impact with exhaustive requirement (skipped when nothing
  //    relevant is left after exclusions — nothing to resolve tests FOR)
  if (inputs.impactMaxConfidence === "LOW" && inputs.policy.requiresExhaustiveImpact && !inputs.contentChangesAllExcluded) {
    reasons.push(reason(VERDICT_REASONS.IMPACT_LOW_CONFIDENCE, "test impact mapping is LOW-confidence only; cannot claim exhaustive relevance", true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // deterministic NOT_APPLICABLE: no executable changed lines at all
  if (inputs.coverage.coverableTotal === 0 && inputs.coverage.gapFiles.length === 0) {
    if (inputs.deletionOnly) {
      if (inputs.policy.deletionOnlyPolicy === "NOT_APPLICABLE") {
        reasons.push(reason(VERDICT_REASONS.NOT_APPLICABLE_NO_EXECUTABLE_CHANGES, "ChangeSet contains deletions only; coverage check not applicable (deletion risk recorded separately)", false));
        return build("NOT_APPLICABLE", inputs, reasons, requiredChecks, nowIso);
      }
      reasons.push(reason(VERDICT_REASONS.DELETION_ONLY_RISK, "deletion-only ChangeSet: deleted lines cannot be covered; needs related tests / static checks / mutation smoke as evidence", true));
      return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
    }
    reasons.push(reason(VERDICT_REASONS.NOT_APPLICABLE_NO_EXECUTABLE_CHANGES, "no executable changed lines found for the coverage check", false));
    return build("NOT_APPLICABLE", inputs, reasons, requiredChecks, nowIso);
  }

  // changed files entirely absent from the artifact are coverage gaps
  if (inputs.coverage.gapFiles.length > 0) {
    reasons.push(
      reason(VERDICT_REASONS.COVERAGE_GAP_FILES, `changed files absent from coverage artifact (cannot set denominator to zero): ${inputs.coverage.gapFiles.join(", ")}`, true)
    );
    if (inputs.coverage.coverableTotal === 0 || inputs.coverage.ratio === null) {
      return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
    }
    return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
  }

  // 6. VERIFIED gate
  const threshold = inputs.policy.changedLinesThreshold;
  const actual = inputs.coverage.ratio ?? 0;
  const checksOk = requiredChecks.every((c) => c.status === "VERIFIED");
  if (checksOk && inputs.coverage.ratio !== null && actual >= threshold) {
    return build("VERIFIED", inputs, [], requiredChecks, nowIso);
  }

  // 7. PARTIAL when some trustworthy evidence exists
  if (anyEvidence) {
    if (inputs.coverage.ratio !== null && actual < threshold) {
      reasons.push(
        reason(
          VERDICT_REASONS.COVERAGE_BELOW_THRESHOLD,
          `changed-line coverage ${(actual * 100).toFixed(1)}% below required ${(threshold * 100).toFixed(1)}% (${inputs.coverage.coveredTotal}/${inputs.coverage.coverableTotal} lines, ${inputs.coverage.uncoveredTotal} uncovered)`,
          true
        )
      );
    } else if (!checksOk) {
      reasons.push(reason(VERDICT_REASONS.PARTIAL_EVIDENCE, "some required checks not fully verified yet", true));
    }
    return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
  }

  // 8. nothing trustworthy
  reasons.push(reason(VERDICT_REASONS.NO_EVIDENCE, "no trustworthy evidence for the current fingerprint", true));
  return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
}

function build(
  status: VerdictStatus,
  inputs: VerdictInputs,
  reasons: VerdictReason[],
  requiredChecks: RequiredCheckStatus[],
  nowIso: string
): Verdict {
  return {
    schemaVersion: "1.0",
    status,
    workspaceFingerprint: inputs.currentFingerprint,
    evaluatedAt: nowIso,
    reasons,
    requiredChecks,
    changedLineCoverage: {
      threshold: inputs.policy.changedLinesThreshold,
      actual: inputs.coverage?.ratio ?? null
    }
  };
}

/** Convenience wrapper for deletion-only detection at call sites. */
export { isDeletionOnly };
