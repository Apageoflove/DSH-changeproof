/**
 * Client-side parsing of canonical ChangeProof tool results.
 * The Client NEVER re-computes Host judgments; it only projects structured
 * results. Unknown schema versions fail loud (ignored with a diagnostic),
 * never guessed (PROJECT.md 9.3).
 */
import { isToolResult, type ChangeProofToolResult, type ToolKind } from "../../shared/result.ts";
import { isVerdictStatus } from "../../shared/status.ts";

export const SUPPORTED_RESULT_SCHEMA = "1.0";

export interface ParsedResult {
  kind: ToolKind;
  ok: boolean;
  /** null when schemaVersion is unsupported or shape invalid. */
  data: unknown;
  error: { code: string; message: string } | null;
  diagnostics: unknown[];
}

export function parseCanonicalResult(raw: unknown): ParsedResult | null {
  if (!isToolResult(raw)) return null;
  if (raw.schemaVersion !== SUPPORTED_RESULT_SCHEMA) {
    return {
      kind: raw.kind,
      ok: false,
      data: null,
      error: { code: "CP_SCHEMA_VERSION_UNSUPPORTED", message: `unsupported tool-result schemaVersion "${raw.schemaVersion}" (client supports ${SUPPORTED_RESULT_SCHEMA})` },
      diagnostics: []
    };
  }
  return {
    kind: raw.kind,
    ok: raw.ok,
    data: raw.data ?? null,
    error: raw.error ? { code: raw.error.code, message: raw.error.message } : null,
    diagnostics: raw.diagnostics ?? []
  };
}

export function extractVerdictStatus(result: ParsedResult): string | null {
  if (!result.ok || !result.data) return null;
  const data = result.data as Record<string, unknown>;
  if (result.kind === "changeproof_verify") {
    const verdict = data["verdict"] as Record<string, unknown> | undefined;
    const status = verdict?.["status"];
    return isVerdictStatus(status) ? status : null;
  }
  if (result.kind === "changeproof_status") {
    const freshness = data["freshness"];
    if (freshness === "stale") return "STALE";
    return null;
  }
  return null;
}

export type { ChangeProofToolResult };
