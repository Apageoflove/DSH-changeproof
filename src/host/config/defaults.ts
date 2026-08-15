import type { VerdictPolicy } from "../analysis/verdict.ts";
import type { ChangeProofConfig } from "./schema.ts";

export const DEFAULT_CONFIG_PATH = ".changeproof.yml";

export const DEFAULT_OUTPUT_LIMITS = {
  maxBytes: 200_000,
  maxLines: 2_000
} as const;

export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  changedLinesThreshold: 1.0,
  requiresExhaustiveImpact: true,
  minimumImpactConfidence: "MEDIUM",
  deletionOnlyPolicy: "PARTIAL"
};

export function verdictPolicyFromConfig(config: ChangeProofConfig): VerdictPolicy {
  return {
    ...DEFAULT_VERDICT_POLICY,
    changedLinesThreshold: config.thresholds.changedLines,
    minimumImpactConfidence: config.thresholds.minimumImpactConfidence,
    // LOW-only impact blocks VERIFIED unless the user explicitly lowered the
    // minimum confidence to LOW.
    requiresExhaustiveImpact: config.thresholds.minimumImpactConfidence !== "LOW"
  };
}
