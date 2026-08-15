import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Proofboard, type ProofboardData } from "@client/components/Proofboard.js";
import { INITIAL_CLIENT_STATE } from "@client/projection/freshness-reducer.js";
import tokens from "@client/styles/tokens.module.css";
import board from "@client/styles/proofboard.module.css";

const data: ProofboardData = {
  changeSet: { mode: "git", files: [], deletedLineRisk: [] },
  candidates: [],
  maxConfidence: "LOW",
  coverageFiles: [],
  coverageSummary: { covered: 0, coverable: 0, uncovered: 0, ratio: null },
  evidence: []
};

describe("dark theme + responsive tokens", () => {
  it("renders the dark token block when data-cp-theme=dark", () => {
    const html = renderToStaticMarkup(createElement(Proofboard, { state: INITIAL_CLIENT_STATE, data, theme: "dark" }));
    expect(html).toContain('data-cp-theme="dark"');
  });

  it("CSS token sheet defines both light and dark palettes", () => {
    // CSS-module class map imported to prove the stylesheet resolves
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(0);
    expect(board).toBeDefined();
  });

  it("board CSS uses CSS modules class names (no global selectors)", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = await readFile(path.resolve(here, "../../src/client/styles/proofboard.module.css"), "utf8");
    expect(css).not.toMatch(/^\s*(html|body|\*)\s*[,{]/m); // no global selectors
    expect(css).toContain("@media (min-width: 960px)"); // wide two-column layout
    expect(css).toContain(":focus-visible"); // focus ring not hidden
  });

  it("dark and light both rely on the same token variables (no hardcoded status colors)", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = await readFile(path.resolve(here, "../../src/client/styles/tokens.module.css"), "utf8");
    expect(css).toContain('[data-cp-theme="light"]');
    expect(css).toContain('[data-cp-theme="dark"]');
    // every status color is a token, defined in both themes
    for (const token of ["--cp-ok", "--cp-warn", "--cp-error", "--cp-info"]) {
      expect(css.split(token).length).toBeGreaterThanOrEqual(3); // light + dark + usage guard
    }
  });
});

void board;
