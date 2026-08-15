/**
 * `changeproof_status` tool: recompute the CURRENT fingerprint and decide
 * whether the latest persisted evidence is fresh or stale (PROJECT.md 8.6).
 */
import path from "node:path";
import type { ChangeProofToolResult } from "../../shared/result.ts";
import { okResult } from "../../shared/result.ts";
import type { EvidenceRecord, Verdict } from "../../shared/models.ts";
import type { HostContext } from "../adapters/dsh/compatibility-facade.ts";
import { analyzeWorkspace, toolError, type AnalyzeOptions } from "./common.ts";
import { EvidenceStore } from "../persistence/evidence-store.ts";

export interface StatusData {
  workspaceFingerprint: string;
  changeSetSummary: {
    mode: "git" | "degraded";
    files: number;
    digest: string;
  };
  latestEvidence: EvidenceRecord | null;
  verdict: Verdict | null;
  /** STALE only after Host re-verification of relevant inputs (never a client guess). */
  freshness: "fresh" | "stale" | "no-evidence";
  staleReason: string | null;
}

export async function statusTool(
  host: HostContext,
  workspaceRootAbs: string,
  options: AnalyzeOptions = {}
): Promise<ChangeProofToolResult<StatusData>> {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const store = new EvidenceStore(path.join(workspaceRootAbs, ".changeproof", "evidence"));
    const latest = await store.latest();

    let freshness: StatusData["freshness"] = "no-evidence";
    let staleReason: string | null = null;
    if (latest) {
      if (latest.workspaceFingerprint === snap.fingerprint && !latest.workspaceChangedDuringRun) {
        freshness = "fresh";
      } else {
        freshness = "stale";
        staleReason =
          "workspace fingerprint no longer matches the evidence binding (changed source/test/lock/config/adapter)";
      }
    }

    return okResult("changeproof_status", {
      workspaceFingerprint: snap.fingerprint,
      changeSetSummary: { mode: snap.changeSet.mode, files: snap.changeSet.files.length, digest: snap.changeSet.digest },
      latestEvidence: latest,
      verdict: null,
      freshness,
      staleReason
    });
  } catch (err) {
    return toolError("changeproof_status", err);
  }
}
