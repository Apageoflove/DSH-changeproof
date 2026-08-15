/**
 * Freshness reducer: folds canonical tool results + observed public mutation
 * tool/results into the UI state. On a likely-mutating tool result the Client
 * ONLY shows a conservative `STALE (pending host confirmation)` — it never
 * decides file truth (PROJECT.md 8.6, 9.3).
 */
import type { VerdictReason } from "../../shared/models.ts";
import type { VerdictStatus } from "../../shared/status.ts";
import { extractVerdictStatus, parseCanonicalResult } from "./canonical-result.ts";

export interface ClientState {
  status: VerdictStatus | null;
  /** true when STALE is a conservative Client guess awaiting Host re-check */
  pendingHostConfirmation: boolean;
  evidenceAgeIso: string | null;
  blockers: VerdictReason[];
  changedLineCoverage: { threshold: number; actual: number | null } | null;
  coverageSummary: { covered: number; coverable: number; uncovered: number } | null;
  lastResultKind: string | null;
  errorMessage: string | null;
}

export const INITIAL_CLIENT_STATE: ClientState = {
  status: null,
  pendingHostConfirmation: false,
  evidenceAgeIso: null,
  blockers: [],
  changedLineCoverage: null,
  coverageSummary: null,
  lastResultKind: null,
  errorMessage: null
};

export type ClientEvent =
  | { type: "tool-result"; raw: unknown }
  | { type: "mutation-observed"; toolId: string; at: string }
  | { type: "reset" };

/** Tool ids that plausibly mutate workspace files (public classification absent). */
const MUTATION_TOOL_PATTERNS = [/write/i, /edit/i, /apply/i, /patch/i, /delete/i, /remove/i, /move/i, /create/i];

export function isLikelyMutationTool(toolId: string): boolean {
  return MUTATION_TOOL_PATTERNS.some((re) => re.test(toolId));
}

export function clientReducer(state: ClientState, event: ClientEvent): ClientState {
  switch (event.type) {
    case "reset":
      return { ...INITIAL_CLIENT_STATE };

    case "mutation-observed": {
      if (state.status === null || state.status === "UNVERIFIED") return state; // nothing to invalidate
      return {
        ...state,
        status: "STALE",
        pendingHostConfirmation: true,
        blockers: [
          {
            code: "CP_CLIENT_CONSERVATIVE_STALE",
            message: `observed possible workspace mutation (${event.toolId}); waiting for host confirmation via changeproof_status/verify`,
            blocking: true
          }
        ]
      };
    }

    case "tool-result": {
      const parsed = parseCanonicalResult(event.raw);
      if (!parsed) return state;
      if (!parsed.kind.startsWith("changeproof_")) {
        // other plugins' tool results: treat likely-mutations conservatively
        return isLikelyMutationTool(parsed.kind) ? clientReducer(state, { type: "mutation-observed", toolId: parsed.kind, at: new Date().toISOString() }) : state;
      }
      const next: ClientState = { ...state, lastResultKind: parsed.kind, errorMessage: parsed.error ? `${parsed.error.code}: ${parsed.error.message}` : null };
      if (!parsed.ok || !parsed.data) {
        if (parsed.kind === "changeproof_plan") return next; // plan errors keep prior verdict visible
        return { ...next, status: "UNVERIFIED", pendingHostConfirmation: false, blockers: parsed.error ? [{ code: parsed.error.code, message: parsed.error.message, blocking: true }] : [] };
      }
      const status = extractVerdictStatus(parsed);
      const data = parsed.data as Record<string, unknown>;
      const verdict = (data["verdict"] ?? null) as Record<string, unknown> | null;
      const covSummary = (data["changedLineCoverageSummary"] ?? null) as Record<string, unknown> | null;
      return {
        ...next,
        status: (status as VerdictStatus | null) ?? next.status,
        pendingHostConfirmation: false,
        evidenceAgeIso: (verdict?.["evaluatedAt"] as string | undefined) ?? next.evidenceAgeIso,
        blockers: ((verdict?.["reasons"] as VerdictReason[] | undefined) ?? []).filter((r) => r.blocking),
        changedLineCoverage: verdict
          ? {
              threshold: (verdict["changedLineCoverage"] as { threshold: number })?.threshold ?? 1,
              actual: (verdict["changedLineCoverage"] as { actual: number | null })?.actual ?? null
            }
          : next.changedLineCoverage,
        coverageSummary: covSummary
          ? {
              covered: Number(covSummary["coveredTotal"] ?? 0),
              coverable: Number(covSummary["coverableTotal"] ?? 0),
              uncovered: Number(covSummary["uncoveredTotal"] ?? 0)
            }
          : next.coverageSummary
      };
    }
  }
}
