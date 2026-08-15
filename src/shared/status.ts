/**
 * 结论状态模型（PROJECT.md §7）。
 * 六种状态，定义严格，判定顺序确定。
 */

export const VERDICT_STATUSES = [
  "VERIFIED",
  "PARTIAL",
  "FAILED",
  "STALE",
  "UNVERIFIED",
  "NOT_APPLICABLE"
] as const;

export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export function isVerdictStatus(v: unknown): v is VerdictStatus {
  return typeof v === "string" && (VERDICT_STATUSES as readonly string[]).includes(v);
}

/** Human-readable labels; STALE must never be presented as "green". */
export const STATUS_LABELS: Readonly<Record<VerdictStatus, string>> = {
  VERIFIED: "已验证",
  PARTIAL: "部分验证",
  FAILED: "失败",
  STALE: "已过期（代码已变化，需重验）",
  UNVERIFIED: "未验证",
  NOT_APPLICABLE: "不适用"
};

export type StatusSeverity = "ok" | "warn" | "error" | "info" | "muted";

/** Semantic severity used by UI; NEVER a substitute for text + reason codes. */
export const STATUS_SEVERITY: Readonly<Record<VerdictStatus, StatusSeverity>> = {
  VERIFIED: "ok",
  PARTIAL: "warn",
  FAILED: "error",
  STALE: "warn",
  UNVERIFIED: "muted",
  NOT_APPLICABLE: "info"
};

/**
 * Evaluation order (PROJECT.md 7): freshness first, then reliable failure,
 * then untrustworthy/unavailable evidence, then partial, then verified.
 * This ordering is enforced by analysis/verdict.ts; the constant documents it.
 */
export const VERDICT_EVALUATION_ORDER = [
  "STALE",
  "FAILED",
  "UNVERIFIED",
  "PARTIAL",
  "VERIFIED",
  "NOT_APPLICABLE"
] as const;
