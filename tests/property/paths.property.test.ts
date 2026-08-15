import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@host/adapters/git/diff-parser.js";
import { normalizeWorkspacePath } from "@shared/schema.js";
import { analyzeChangedLineCoverage } from "@host/analysis/changed-lines.js";
import type { ChangeSet } from "@shared/models.js";

describe("property: path normalization vs glob matching", () => {
  it("every accepted path round-trips through normalization", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b-c", "d.e", "f_g", "123", "ts"), { minLength: 1, maxLength: 5 }),
        (segs) => {
          const p = segs.join("/");
          const n1 = normalizeWorkspacePath(p);
          const n2 = normalizeWorkspacePath(n1!);
          expect(n1).toBe(n2);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("property: diff parser line accounting", () => {
  const lineArb = fc.constantFrom("code-a", "code-b", "", "  indented");
  const hunkLineArb = fc.oneof(
    lineArb.map((l) => ({ kind: "+" as const, text: l })),
    lineArb.map((l) => ({ kind: "-" as const, text: l })),
    lineArb.map((l) => ({ kind: " " as const, text: l }))
  );

  it("counts added/deleted lines exactly", () => {
    fc.assert(
      fc.property(fc.array(hunkLineArb, { minLength: 0, maxLength: 40 }), (body) => {
        const added = body.filter((l) => l.kind === "+").length;
        const deleted = body.filter((l) => l.kind === "-").length;
        const newLines = body.filter((l) => l.kind !== "-").length;
        const oldLines = body.filter((l) => l.kind !== "+").length;
        const fmt = (n: number) => (n === 1 ? "" : `,${n}`);
        const diff = [
          "diff --git a/f.ts b/f.ts",
          `@@ -1${fmt(oldLines)} +1${fmt(newLines)} @@`,
          ...body.map((l) => l.kind + l.text),
          ""
        ].join("\n");
        const files = parseUnifiedDiff(diff);
        expect(files).toHaveLength(1);
        expect(files[0]!.linesAdded).toBe(added);
        expect(files[0]!.linesDeleted).toBe(deleted);
      }),
      { numRuns: 300 }
    );
  });
});

describe("property: changed-line coverage totals are internally consistent", () => {
  const linesArb = fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { maxLength: 30 });

  it("covered + uncovered == coverable and ratio in [0,1]", () => {
    fc.assert(
      fc.property(linesArb, linesArb, (executable, coveredSeed) => {
        const execSet = new Map([["src/a.ts", new Set(executable)]]);
        const covered = new Set(coveredSeed.filter((l) => executable.includes(l)));
        const covSet = new Map([["src/a.ts", covered]]);
        const changeSet: ChangeSet = {
          schemaVersion: "1.0",
          mode: "git",
          workspaceId: "sha256:w",
          baseline: { kind: "head", commit: "c" },
          digest: "sha256:d",
          diagnostics: [],
          files: [
            {
              path: "src/a.ts",
              status: "modified",
              contentDigest: "sha256:f",
              ranges: [{ startLine: 1, endLine: 200, kind: "modified" }],
              coverableExecutableLines: [],
              linesAdded: 10,
              linesDeleted: 2
            }
          ]
        };
        const result = analyzeChangedLineCoverage(changeSet, execSet, covSet, []);
        expect(result.coveredTotal + result.uncoveredTotal).toBe(result.coverableTotal);
        if (result.ratio !== null) {
          expect(result.ratio).toBeGreaterThanOrEqual(0);
          expect(result.ratio).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 }
    );
  });
});
