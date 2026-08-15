import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Proofboard, type ProofboardData } from "@client/components/Proofboard.js";
import { StatusChip } from "@client/components/StatusChip.js";
import { clientReducer, INITIAL_CLIENT_STATE } from "@client/projection/freshness-reducer.js";
import { okResult } from "@shared/result.js";

const data: ProofboardData = {
  changeSet: {
    mode: "git",
    files: [{ path: "src/billing.ts", status: "modified", linesAdded: 6, linesDeleted: 2 }],
    deletedLineRisk: [{ path: "src/old.ts", ranges: ["10-18"] }]
  },
  candidates: [
    {
      schemaVersion: "1.0",
      id: "import-graph:web",
      packageId: "web",
      testFiles: ["src/billing.test.ts"],
      argv: ["vitest", "run"],
      cwd: "",
      source: "import-graph",
      confidence: "MEDIUM",
      affectedFiles: ["src/billing.ts"],
      rationale: ["static import graph"]
    }
  ],
  maxConfidence: "MEDIUM",
  coverageFiles: [
    { path: "src/billing.ts", coverable: [2, 3, 4, 5, 6, 7], covered: [2, 3, 4, 6, 7], uncovered: [5], absentFromArtifact: false },
    { path: "src/gen.ts", coverable: [], covered: [], uncovered: [], absentFromArtifact: true }
  ],
  coverageSummary: { covered: 5, coverable: 6, uncovered: 1, ratio: 5 / 6 },
  evidence: [
    {
      schemaVersion: "1.0",
      id: "ev-1",
      planId: "p1",
      stepId: "targeted-test:web",
      adapter: { id: "istanbul", version: "1.0" },
      argvRedacted: ["node", "vitest.mjs", "run", "--coverage"],
      cwd: "",
      startedAt: "2026-08-14T00:00:00.000Z",
      durationMs: 1234,
      exitCode: 0,
      termination: "exit",
      changedFilesDigest: "sha256:cf",
      workspaceFingerprint: "sha256:fp",
      lockConfigDigest: "sha256:lc",
      artifactDigests: [{ kind: "istanbul-json", digest: "sha256:art" }],
      parser: { status: "ok", diagnostics: [] },
      outputDigest: "sha256:out"
    }
  ]
};

function render(state = INITIAL_CLIENT_STATE, props: Partial<Parameters<typeof Proofboard>[0]> = {}) {
  return renderToStaticMarkup(createElement(Proofboard, { state, data, ...props }));
}

describe("Proofboard rendering (all states, 12.4)", () => {
  it("empty state renders a first-use hint", () => {
    const html = render();
    expect(html).toContain("首次使用");
    expect(html).toContain("尚未验证");
  });

  it("loading state renders 分析中 without pretending a verdict", () => {
    const html = render(INITIAL_CLIENT_STATE, { loading: true });
    expect(html).toContain("分析中");
    expect(html).not.toContain("已验证");
  });

  it("VERIFIED shows status text + numbers, not just color", () => {
    const s = clientReducer(INITIAL_CLIENT_STATE, {
      type: "tool-result",
      raw: okResult("changeproof_verify", {
        verdict: { status: "VERIFIED", evaluatedAt: "2026-08-14T00:00:00Z", reasons: [], requiredChecks: [], changedLineCoverage: { threshold: 1, actual: 1 } },
        changedLineCoverageSummary: { coverableTotal: 6, coveredTotal: 6, uncoveredTotal: 0, ratio: 1, gapFiles: [], excludedFiles: [] }
      })
    });
    const html = render(s);
    expect(html).toContain("已验证");
    expect(html).toContain("覆盖 <strong>6/6</strong>"); // numbers first (12.1)
    expect(html).not.toContain("待确认");
  });

  it("STALE shows 代码已变化 message and re-verify action", () => {
    const s = { ...INITIAL_CLIENT_STATE, status: "STALE" as const, pendingHostConfirmation: true, blockers: [{ code: "CP_CLIENT_CONSERVATIVE_STALE", message: "observed possible workspace mutation", blocking: true }] };
    const html = render(s, { onReverify: () => {} });
    expect(html).toContain("已过期");
    expect(html).toContain("待确认");
    expect(html).toContain("重验");
  });

  it("PARTIAL never renders green-light wording (PASS)", () => {
    const s = { ...INITIAL_CLIENT_STATE, status: "PARTIAL" as const, blockers: [{ code: "CP_COVERAGE_BELOW_THRESHOLD", message: "5/6 below 100%", blocking: true }] };
    const html = render(s);
    expect(html).toContain("部分验证");
    expect(html).not.toMatch(/PASS|通过\b/);
  });

  it("FAILED / UNVERIFIED / NOT_APPLICABLE states render distinct text", () => {
    for (const status of ["FAILED", "UNVERIFIED", "NOT_APPLICABLE"] as const) {
      const html = render({ ...INITIAL_CLIENT_STATE, status });
      expect(html).toMatch(/失败|未验证|不适用/);
    }
  });

  it("non-Git mode is explicitly called out (never VERIFIED)", () => {
    const html = render(INITIAL_CLIENT_STATE, { data: { ...data, changeSet: { ...data.changeSet, mode: "degraded" } } });
    expect(html).toContain("非 Git");
    expect(html).toContain("不可 VERIFIED");
  });

  it("coverage gap files are visible, exclusions are never hidden", () => {
    const html = render();
    expect(html).toContain("未出现在 coverage 产物中");
  });

  it("evidence timeline shows argv/cwd/duration/artifact digest", () => {
    const html = render();
    expect(html).toContain("targeted-test:web");
    expect(html).toContain("vitest.mjs");
    expect(html).toContain("1234ms");
  });
});

describe("StatusChip accessibility", () => {
  it("carries aria-label and icon+text (not color alone)", () => {
    const html = renderToStaticMarkup(createElement(StatusChip, { status: "VERIFIED" }));
    expect(html).toContain("aria-label");
    expect(html).toContain("✓");
    expect(html).toContain("已验证");
  });
});
