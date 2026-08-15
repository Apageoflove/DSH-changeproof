import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { istanbulAdapter } from "@host/adapters/javascript/istanbul.js";
import { coveragePyAdapter } from "@host/adapters/python/coverage-json.js";
import { normalizeArtifactPath } from "@host/adapters/types.js";
import { CpError } from "@shared/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../../fixtures");
const ROOT = "E:/ws/demo";

const opts = { workspaceRootAbs: ROOT, maxFileEntries: 5000, maxLinesPerFile: 100_000 };

describe("contract: Istanbul coverage-final.json (pinned fixture)", () => {
  it("parses the checked-in fixture exactly", () => {
    const text = readFileSync(path.join(fixturesRoot, "js-vitest", "coverage-final.json"), "utf8");
    const art = istanbulAdapter.parse(text, opts);
    const exec = art.executableByFile.get("src/billing.ts");
    const cov = art.coveredByFile.get("src/billing.ts");
    expect(exec).toBeDefined();
    expect(cov).toBeDefined();
    expect([...exec!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // line 5 (the exception branch) is executable but uncovered
    expect([...cov!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6]);
  });

  it("normalizes absolute artifact keys to workspace-relative paths", () => {
    const artifact = {
      [`${ROOT}/src/a.ts`]: {
        statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
        s: { "0": 2 }
      },
      "src/b.ts": {
        statementMap: { "0": { start: { line: 2 }, end: { line: 2 } } },
        s: { "0": 0 }
      },
      "/etc/passwd": {
        statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
        s: { "0": 1 }
      }
    };
    const art = istanbulAdapter.parse(JSON.stringify(artifact), opts);
    expect(art.executableByFile.has("src/a.ts")).toBe(true);
    expect(art.executableByFile.has("src/b.ts")).toBe(true);
    expect(art.executableByFile.has("/etc/passwd")).toBe(false);
    expect(art.coveredByFile.get("src/b.ts")!.size).toBe(0);
    expect(art.diagnostics.some((d) => d.includes("outside workspace"))).toBe(true);
  });

  it("rejects invalid JSON, wrong shapes, and forbidden keys", () => {
    expect(() => istanbulAdapter.parse("not json", opts)).toThrowError(CpError);
    expect(() => istanbulAdapter.parse("[]", opts)).toThrowError(/root must be an object/);
    expect(() => istanbulAdapter.parse('{"a.ts": 42}', opts)).toThrowError(/must be an object/);
    expect(() => istanbulAdapter.parse('{"a.ts": {"s": {}}}', opts)).toThrowError(/statementMap/);
    expect(() =>
      istanbulAdapter.parse(
        JSON.stringify({ "a.ts": { statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } }, s: { "0": 1 } }, __proto__: {} } ),
        opts
      )
    ).not.toThrow(); // JSON.parse drops __proto__ as own key; canonicalize guard covers re-stringify
    expect(() =>
      istanbulAdapter.parse('{"constructor": {"statementMap": {}, "s": {}}}', opts)
    ).toThrowError(/forbidden key/);
  });

  it("rejects out-of-range line numbers and parallel-array violations", () => {
    expect(() =>
      istanbulAdapter.parse('{"a.ts": {"statementMap": {"0": {"start": {"line": 0}, "end": {"line": 1}}}, "s": {"0": 1}}}', opts)
    ).toThrowError(/invalid line numbers/);
    expect(() =>
      istanbulAdapter.parse(
        '{"a.ts": {"statementMap": {"0": {"start": {"line": 1}, "end": {"line": 2}}}, "s": {"0": 1}, "branchMap": {"0": {"locations": [null]}}, "b": {"0": [1, 2]}}}',
        opts
      )
    ).toThrowError(/parallel/);
  });

  it("enforces the file-entry resource cap", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) {
      many[`f${i}.ts`] = { statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } }, s: { "0": 1 } };
    }
    expect(() => istanbulAdapter.parse(JSON.stringify(many), { ...opts, maxFileEntries: 10 })).toThrowError(/cap 10/);
  });
});

describe("contract: coverage.py JSON (REAL artifact from coverage 7.15.4, format 3)", () => {
  it("parses the checked-in real fixture exactly", () => {
    const text = readFileSync(path.join(fixturesRoot, "python-pytest", "coverage.json"), "utf8");
    const art = coveragePyAdapter.parse(text, opts);
    // real artifact: src\calc.py executed [1,2,3] missing [4] (windows-separator keys normalized)
    const exec = art.executableByFile.get("src/calc.py");
    const cov = art.coveredByFile.get("src/calc.py");
    expect([...exec!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect([...cov!].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("treats executed ∪ missing as executable and honors excluded_lines", () => {
    const artifact = {
      meta: { format: 3, version: "7.15.4", timestamp: "2026-08-14T00:00:00" },
      files: {
        "src/app.py": { executed_lines: [1, 2], missing_lines: [3, 4], excluded_lines: [4], summary: {} }
      }
    };
    const art = coveragePyAdapter.parse(JSON.stringify(artifact), opts);
    expect([...art.executableByFile.get("src/app.py")!]).toEqual([1, 2, 3]);
    expect([...art.coveredByFile.get("src/app.py")!]).toEqual([1, 2]);
  });

  it("fails loud on unknown schema versions and invalid line values", () => {
    const mk = (meta: Record<string, unknown>) => JSON.stringify({ meta, files: { "a.py": { executed_lines: [1], missing_lines: [] } } });
    expect(() => coveragePyAdapter.parse(mk({ format: 3, version: "9.9" }), opts)).toThrowError(/unsupported coverage.py version/);
    expect(() => coveragePyAdapter.parse(mk({ format: 4, version: "7.15.4" }), opts)).toThrowError(/meta.format/);
    expect(() => coveragePyAdapter.parse(mk({ format: "json", version: "7.15.4" }), opts)).toThrowError(/meta.format/);
    expect(() =>
      coveragePyAdapter.parse(
        JSON.stringify({
          meta: { format: 3, version: "7.15.4" },
          files: { "a.py": { executed_lines: [-1], missing_lines: [] } }
        }),
        opts
      )
    ).toThrowError(/invalid line/);
  });
});

describe("normalizeArtifactPath security", () => {
  it("rejects escapes and accepts in-workspace forms", () => {
    expect(normalizeArtifactPath("src/a.ts", ROOT)).toBe("src/a.ts");
    expect(normalizeArtifactPath(`${ROOT}/src/a.ts`, ROOT)).toBe("src/a.ts");
    expect(normalizeArtifactPath(`${ROOT}\\src\\a.ts`, ROOT)).toBe("src/a.ts");
    expect(normalizeArtifactPath("../outside.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("/etc/passwd", ROOT)).toBeNull();
    expect(normalizeArtifactPath("D:/evil/x.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("E:/evil/x.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath(`${ROOT.slice(0, 8)}evil/x.ts`, ROOT)).toBeNull();
    expect(normalizeArtifactPath("", ROOT)).toBeNull();
    expect(normalizeArtifactPath("a\0b", ROOT)).toBeNull();
  });
});
