/**
 * `changeproof_plan` tool: analysis only — never executes project code.
 */
import type { ChangeProofToolResult } from "../../shared/result.ts";
import { okResult } from "../../shared/result.ts";
import type { HostContext } from "../adapters/dsh/compatibility-facade.ts";
import { sha256Hex } from "../adapters/dsh/fs-port.ts";
import { buildPlan } from "../execution/planner.ts";
import { analyzeWorkspace, diagnosticsFromSnapshot, toolError, type AnalyzeOptions } from "./common.ts";
import { deletedLineRiskOf } from "../analysis/deletion-risk.ts";

export interface PlanData {
  changeSetSummary: {
    mode: "git" | "degraded";
    baseline: { kind: string; commit: string | null };
    files: Array<{ path: string; status: string; linesAdded: number; linesDeleted: number }>;
    deletedLineRisk: ReturnType<typeof deletedLineRiskOf>;
    digest: string;
  };
  impact: {
    candidates: ReturnType<typeof buildPlan>["candidates"];
    maxConfidence: "HIGH" | "MEDIUM" | "LOW";
  };
  steps: ReturnType<typeof buildPlan>["steps"];
  preview: Array<{ stepId: string; argv: string[]; cwd: string; timeoutMs: number; expectedArtifacts: string[] }>;
  planId: string;
  workspaceFingerprint: string;
}

export async function planTool(
  host: HostContext,
  workspaceRootAbs: string,
  options: AnalyzeOptions = {}
): Promise<ChangeProofToolResult<PlanData>> {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const plan = buildPlan(
      {
        config: snap.config,
        candidates: snap.candidates,
        changeSetDigest: snap.changeSet.digest,
        workspaceFingerprint: snap.fingerprint,
        nowIso: new Date().toISOString()
      },
      sha256Hex
    );
    return okResult(
      "changeproof_plan",
      {
        changeSetSummary: {
          mode: snap.changeSet.mode,
          baseline: snap.changeSet.baseline,
          files: snap.changeSet.files.map((f) => ({
            path: f.path,
            status: f.status,
            linesAdded: f.linesAdded,
            linesDeleted: f.linesDeleted
          })),
          deletedLineRisk: deletedLineRiskOf(snap.changeSet.files),
          digest: snap.changeSet.digest
        },
        impact: { candidates: plan.candidates, maxConfidence: snap.maxConfidence },
        steps: plan.steps,
        preview: plan.steps
          .filter((s) => s.argv.length > 0)
          .map((s) => ({ stepId: s.id, argv: s.argv, cwd: s.cwd, timeoutMs: s.timeoutMs, expectedArtifacts: s.expectedArtifacts })),
        planId: plan.id,
        workspaceFingerprint: snap.fingerprint
      },
      diagnosticsFromSnapshot(snap).concat(
        plan.diagnostics.map((message) => ({ severity: "info" as const, code: "CP_PLAN_INFO", message }))
      )
    );
  } catch (err) {
    return toolError("changeproof_plan", err);
  }
}
