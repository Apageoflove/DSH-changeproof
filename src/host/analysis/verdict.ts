/**
 * 结论状态机（PROJECT.md 7, 8.8）。
 * 判定顺序：STALE → FAILED → UNVERIFIED(带原因) → PARTIAL → VERIFIED。
 * NOT_APPLICABLE 只能由带原因码的确定性规则产生。
 *
 * 硬性规则：
 *  - exit 0 但无覆盖产物 / 解析错误 / 低置信度映射 → 绝不 VERIFIED；
 *  - 非 Git 工作区 → 绝不 VERIFIED；
 *  - 证据绑定旧指纹 → 一律 STALE（即使命令都通过）。
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
  /** true 时，只有 LOW 置信度映射就不能 VERIFIED（要求穷尽）。 */
  requiresExhaustiveImpact: boolean;
  minimumImpactConfidence: Confidence;
  /** 仅删除的变更集默认 PARTIAL（open question #5）。 */
  deletionOnlyPolicy: "PARTIAL" | "NOT_APPLICABLE";
}

export interface VerdictInputs {
  currentFingerprint: Digest;
  changeSetMode: "git" | "degraded";
  changeSetParseError: boolean;
  /** 变更集是否只有删除。 */
  deletionOnly: boolean;
  /** 非删除改动是否全部被 exclude 规则排除（如只改了生成文件）：
   *  此时不要求 impact 解析，覆盖检查判 NOT_APPLICABLE 而不是被 LOW 卡住。 */
  contentChangesAllExcluded: boolean;
  impactMaxConfidence: Confidence;
  coverage: ChangedLinesResult | null; // null = 没有任何覆盖产物被解析
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

  // 逐个检查项的状态
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

  // 1. 新鲜度优先
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

  // 2. 可靠的失败
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

  // spawn-error：有证据但执行根本没开始
  const spawnErrored = required.filter((c) => c.evidence?.termination === "spawn-error");
  if (spawnErrored.length > 0) {
    reasons.push(reason(VERDICT_REASONS.SPAWN_ERROR, `required check could not start: ${spawnErrored.map((c) => c.id).join(", ")}`, true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // 3. 非 Git / 解析错误
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

  // 4. 缺必需证据 / 解析错误
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

  // 5. 只有 LOW 置信度映射且要求穷尽（全部改动被排除时跳过——
  //    没有需要解析测试的对象）
  if (inputs.impactMaxConfidence === "LOW" && inputs.policy.requiresExhaustiveImpact && !inputs.contentChangesAllExcluded) {
    reasons.push(reason(VERDICT_REASONS.IMPACT_LOW_CONFIDENCE, "test impact mapping is LOW-confidence only; cannot claim exhaustive relevance", true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }

  // 确定性 NOT_APPLICABLE：没有可执行改动行
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

  // 改动文件完全不在产物中 = 覆盖缺口
  if (inputs.coverage.gapFiles.length > 0) {
    reasons.push(
      reason(VERDICT_REASONS.COVERAGE_GAP_FILES, `changed files absent from coverage artifact (cannot set denominator to zero): ${inputs.coverage.gapFiles.join(", ")}`, true)
    );
    if (inputs.coverage.coverableTotal === 0 || inputs.coverage.ratio === null) {
      return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
    }
    return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
  }

  // 6. VERIFIED 门槛
  const threshold = inputs.policy.changedLinesThreshold;
  const actual = inputs.coverage.ratio ?? 0;
  const checksOk = requiredChecks.every((c) => c.status === "VERIFIED");
  if (checksOk && inputs.coverage.ratio !== null && actual >= threshold) {
    return build("VERIFIED", inputs, [], requiredChecks, nowIso);
  }

  // 7. 有可信证据但没全过 → PARTIAL
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

  // 8. 没有任何可信证据
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
