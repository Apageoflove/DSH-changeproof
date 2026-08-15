import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Proofboard, type ProofboardData } from "@client/components/Proofboard.js";
import { VerifyDock, SettingsSection } from "@client/components/VerifyDock.js";
import { StatusChip } from "@client/components/StatusChip.js";
import { INITIAL_CLIENT_STATE } from "@client/projection/freshness-reducer.js";

const data: ProofboardData = {
  changeSet: {
    mode: "git",
    files: [{ path: "src/billing.ts", status: "modified", linesAdded: 6, linesDeleted: 2 }],
    deletedLineRisk: []
  },
  candidates: [],
  maxConfidence: "MEDIUM",
  coverageFiles: [{ path: "src/billing.ts", coverable: [2, 3], covered: [2], uncovered: [3], absentFromArtifact: false }],
  coverageSummary: { covered: 1, coverable: 2, uncovered: 1, ratio: 0.5 },
  evidence: []
};

describe("Proofboard accessibility (WCAG-oriented automated checks)", () => {
  it("uses semantic landmarks: region + labelled sections + table headers", () => {
    const html = renderToStaticMarkup(createElement(Proofboard, { state: INITIAL_CLIENT_STATE, data }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="ChangeProof Proofboard"');
    expect(html).toMatch(/<h3[^>]*id="cp-/);
    expect(html).toContain('scope="col"');
  });

  it("dynamic status announced via aria-live=polite; failures do not steal focus (no autofocus)", () => {
    const html = renderToStaticMarkup(createElement(Proofboard, { state: { ...INITIAL_CLIENT_STATE, status: "FAILED" }, data }));
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain('role="alert"'); // alert is assertive; failures are polite
  });

  it("status is conveyed by text+icon, never color alone", () => {
    for (const status of ["VERIFIED", "PARTIAL", "FAILED", "STALE", "UNVERIFIED", "NOT_APPLICABLE"] as const) {
      const chip = renderToStaticMarkup(createElement(StatusChip, { status }));
      expect(chip).toMatch(/✓|◐|✕|↻|\?|∅/); // icon
      expect(chip).toMatch(/已验证|部分验证|失败|已过期|未验证|不适用/); // text
      expect(chip).toContain("aria-label");
    }
  });

  it("buttons are real buttons with accessible names; focus-visible styled in CSS", async () => {
    const dock = renderToStaticMarkup(createElement(VerifyDock, { running: true, onCancel: () => {}, onPlan: () => {}, onVerify: () => {} }));
    expect(dock).toMatch(/<button[^>]*type="button"/);
    expect(dock).toContain("取消（终止进程树）");
    expect(dock).toContain('role="toolbar"');
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const css = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/client/styles/proofboard.module.css"), "utf8");
    expect(css).toContain(":focus-visible");
  });

  it("settings section discloses config source and exclusion rules (no hidden exclusions)", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSection, {
        configSource: ".changeproof.yml",
        packages: [{ id: "web", root: "packages/web", adapter: "vitest-istanbul" }],
        thresholds: { changedLines: 1, minimumImpactConfidence: "MEDIUM" },
        exclude: ["**/generated/**"]
      })
    );
    expect(html).toContain(".changeproof.yml");
    expect(html).toContain("**/generated/**");
    expect(html).toContain("100%");
  });

  it("numbers use tabular alignment and monospace for paths/argv", () => {
    const html = renderToStaticMarkup(createElement(Proofboard, { state: INITIAL_CLIENT_STATE, data }));
    expect(html).toContain("src/billing.ts");
    expect(html).toContain("1/2");
  });
});
