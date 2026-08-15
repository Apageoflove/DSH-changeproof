import { describe, expect, it } from "vitest";
import { clientReducer, INITIAL_CLIENT_STATE, isLikelyMutationTool } from "@client/projection/freshness-reducer.js";
import { parseCanonicalResult } from "@client/projection/canonical-result.js";
import { okResult } from "@shared/result.js";

const verifyOk = okResult("changeproof_verify", {
  verdict: {
    schemaVersion: "1.0",
    status: "VERIFIED",
    workspaceFingerprint: "sha256:x",
    evaluatedAt: "2026-08-14T00:00:00.000Z",
    reasons: [],
    requiredChecks: [{ id: "targeted-test:web", status: "VERIFIED", evidenceId: "ev-1" }],
    changedLineCoverage: { threshold: 1, actual: 1 }
  },
  changedLineCoverageSummary: { coverableTotal: 4, coveredTotal: 4, uncoveredTotal: 0, ratio: 1, gapFiles: [], excludedFiles: [] },
  evidence: [],
  coverageByFile: [],
  plan: {},
  workspaceChangedDuringRun: false
});

describe("client freshness reducer", () => {
  it("starts empty and stays empty on reset", () => {
    expect(INITIAL_CLIENT_STATE.status).toBeNull();
    expect(clientReducer(INITIAL_CLIENT_STATE, { type: "reset" }).status).toBeNull();
  });

  it("folds a changeproof_verify result into VERIFIED", () => {
    const s = clientReducer(INITIAL_CLIENT_STATE, { type: "tool-result", raw: verifyOk });
    expect(s.status).toBe("VERIFIED");
    expect(s.pendingHostConfirmation).toBe(false);
    expect(s.coverageSummary).toEqual({ covered: 4, coverable: 4, uncovered: 0 });
    expect(s.changedLineCoverage).toEqual({ threshold: 1, actual: 1 });
  });

  it("conservative STALE on observed mutation tool result (pending host confirmation)", () => {
    const verified = clientReducer(INITIAL_CLIENT_STATE, { type: "tool-result", raw: verifyOk });
    const stale = clientReducer(verified, { type: "mutation-observed", toolId: "fs_write", at: "2026-08-14T01:00:00.000Z" });
    expect(stale.status).toBe("STALE");
    expect(stale.pendingHostConfirmation).toBe(true);
    expect(stale.blockers[0]!.code).toBe("CP_CLIENT_CONSERVATIVE_STALE");
  });

  it("host status result clears the conservative guess", () => {
    const verified = clientReducer(INITIAL_CLIENT_STATE, { type: "tool-result", raw: verifyOk });
    const stale = clientReducer(verified, { type: "mutation-observed", toolId: "fs_write", at: "x" });
    const confirmed = clientReducer(stale, {
      type: "tool-result",
      raw: okResult("changeproof_status", { freshness: "fresh", workspaceFingerprint: "sha256:x", changeSetSummary: { mode: "git", files: 1, digest: "sha256:d" }, latestEvidence: null, verdict: null, staleReason: null })
    });
    // status tool carries no verdict status: freshness fresh keeps last verdict but clears pending flag
    expect(confirmed.pendingHostConfirmation).toBe(false);
  });

  it("changeproof_status with stale freshness maps to STALE", () => {
    const s = clientReducer(INITIAL_CLIENT_STATE, {
      type: "tool-result",
      raw: okResult("changeproof_status", { freshness: "stale", staleReason: "fingerprint mismatch" })
    });
    expect(s.status).toBe("STALE");
  });

  it("tool errors surface as UNVERIFIED with message", () => {
    const s = clientReducer(INITIAL_CLIENT_STATE, {
      type: "tool-result",
      raw: { schemaVersion: "1.0", kind: "changeproof_verify", ok: false, data: null, error: { code: "CP_COVERAGE_PARSE_ERROR", message: "bad" }, diagnostics: [] }
    });
    expect(s.status).toBe("UNVERIFIED");
    expect(s.errorMessage).toContain("CP_COVERAGE_PARSE_ERROR");
  });

  it("unknown schemaVersion fails loud instead of guessing fields", () => {
    const parsed = parseCanonicalResult({ schemaVersion: "9.9", kind: "changeproof_verify", ok: true, data: {}, diagnostics: [] });
    expect(parsed!.ok).toBe(false);
    expect(parsed!.error!.code).toBe("CP_SCHEMA_VERSION_UNSUPPORTED");
  });

  it("mutation heuristics match write/edit-style tools only", () => {
    expect(isLikelyMutationTool("fs_write")).toBe(true);
    expect(isLikelyMutationTool("apply_patch")).toBe(true);
    expect(isLikelyMutationTool("grep")).toBe(false);
    expect(isLikelyMutationTool("read_file")).toBe(false);
  });
});
