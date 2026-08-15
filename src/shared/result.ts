/**
 * 规范化工具结果封装（PROJECT.md 9.1）。
 * 每个工具都返回 { schemaVersion, kind, ok, data, diagnostics }；
 * 错误也是结构化对象——界面不解析自由文本。
 */
import type { VerdictStatus } from "./status.ts";

export const TOOL_RESULT_SCHEMA_VERSION = "1.0";

export type ToolKind = "changeproof_plan" | "changeproof_verify" | "changeproof_status";

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface ChangeProofToolResult<T> {
  schemaVersion: string;
  kind: ToolKind;
  ok: boolean;
  data: T | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  diagnostics: Diagnostic[];
}

export function okResult<T>(kind: ToolKind, data: T, diagnostics: Diagnostic[] = []): ChangeProofToolResult<T> {
  return { schemaVersion: TOOL_RESULT_SCHEMA_VERSION, kind, ok: true, data, error: null, diagnostics };
}

export function errorResult(
  kind: ToolKind,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  diagnostics: Diagnostic[] = []
): ChangeProofToolResult<never> {
  return { schemaVersion: TOOL_RESULT_SCHEMA_VERSION, kind, ok: false, data: null, error: { code, message, details }, diagnostics };
}

export function isToolResult(v: unknown): v is ChangeProofToolResult<unknown> {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.schemaVersion === "string" &&
    typeof o.kind === "string" &&
    typeof o.ok === "boolean" &&
    Array.isArray(o.diagnostics)
  );
}

/** Exit policy mapping for headless/CI consumers (PROJECT.md 9.4). */
export const EXIT_POLICY: Readonly<Record<VerdictStatus, number>> = {
  VERIFIED: 0,
  NOT_APPLICABLE: 0,
  PARTIAL: 3,
  FAILED: 1,
  STALE: 2,
  UNVERIFIED: 4
};
