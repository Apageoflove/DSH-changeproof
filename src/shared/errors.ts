/**
 * ChangeProof 错误码与错误类型。
 * Host/Client 共用；必须可 JSON 序列化，不 import Node-only 或 DSH 私有模块。
 */

export const ERROR_CODES = [
  // configuration
  "CP_CONFIG_NOT_FOUND",
  "CP_CONFIG_INVALID",
  // change set
  "CP_NOT_A_GIT_REPO",
  "CP_GIT_FAILED",
  "CP_DIFF_PARSE_ERROR",
  "CP_CHANGESET_UNAVAILABLE",
  // execution
  "CP_COMMAND_POLICY_REJECTED",
  "CP_SPAWN_ERROR",
  "CP_TIMEOUT",
  "CP_CANCELLED",
  "CP_OUTPUT_LIMIT_EXCEEDED",
  "CP_WORKSPACE_CHANGED_DURING_VERIFY",
  // coverage parsing
  "CP_COVERAGE_ARTIFACT_MISSING",
  "CP_COVERAGE_PARSE_ERROR",
  "CP_COVERAGE_SCHEMA_UNKNOWN",
  "CP_COVERAGE_RESOURCE_EXCEEDED",
  // path safety
  "CP_PATH_ESCAPE",
  "CP_PATH_NOT_FOUND",
  // evidence / verdict
  "CP_EVIDENCE_UNAVAILABLE",
  "CP_SCHEMA_VERSION_UNSUPPORTED",
  "CP_IMPACT_UNRESOLVED",
  // tool level
  "CP_TOOL_INPUT_INVALID",
  "CP_INTERNAL_ERROR"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "CpError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
