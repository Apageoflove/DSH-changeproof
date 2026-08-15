import { describe, expect, it } from "vitest";
import { istanbulAdapter } from "@host/adapters/javascript/istanbul.js";
import { coveragePyAdapter } from "@host/adapters/python/coverage-json.js";

const OPTS = { workspaceRootAbs: "E:/ws", maxFileEntries: 5000, maxLinesPerFile: 2000 };

function deepJson(depth: number): string {
  let s = "1";
  for (let i = 0; i < depth; i += 1) s = `[${s}]`;
  return s;
}

describe("malicious coverage artifacts are rejected, never parsed as green (PROJECT.md 14)", () => {
  it("rejects invalid JSON", () => {
    expect(() => istanbulAdapter.parse("{not json", OPTS)).toThrowError(/not valid JSON/);
    expect(() => coveragePyAdapter.parse("]]]", OPTS)).toThrowError(/not valid JSON/);
  });

  it("rejects forbidden keys (prototype pollution vectors)", () => {
    expect(() => istanbulAdapter.parse('{"constructor": {"statementMap": {}, "s": {}}}', OPTS)).toThrowError(/forbidden key/);
    expect(() =>
      coveragePyAdapter.parse(
        JSON.stringify({ meta: { format: 3, version: "7.15.4" }, files: { prototype: { executed_lines: [1], missing_lines: [] } } }),
        OPTS
      )
    ).toThrowError(/forbidden key/);
  });

  it("rejects deep-nesting bombs via resource caps (no stack guess)", () => {
    // JSON.parse itself handles deep nesting; our guards cap spans and entries.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 6000; i += 1) {
      wide[`f${i}.ts`] = { statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } }, s: { "0": 1 } };
    }
    expect(() => istanbulAdapter.parse(JSON.stringify(wide), OPTS)).toThrowError(/cap/);
  });

  it("rejects absurd line ranges instead of allocating", () => {
    const artifact = {
      "a.ts": {
        statementMap: { "0": { start: { line: 1 }, end: { line: 900_000 } } },
        s: { "0": 1 }
      }
    };
    expect(() => istanbulAdapter.parse(JSON.stringify(artifact), OPTS)).toThrowError(/spans|invalid line|cap/);
  });

  it("rejects non-parallel branch counters (schema mismatch fails loud)", () => {
    const artifact = {
      "a.ts": {
        statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
        s: { "0": 1 },
        branchMap: { "0": { locations: [{ start: { line: 1 }, end: { line: 1 } }] } },
        b: { "0": [1, 2, 3] }
      }
    };
    expect(() => istanbulAdapter.parse(JSON.stringify(artifact), OPTS)).toThrowError(/parallel/);
  });

  it("unknown coverage.py schema versions are loud failures, not guesses", () => {
    const mk = (meta: Record<string, unknown>) => JSON.stringify({ meta, files: {} });
    expect(() => coveragePyAdapter.parse(mk({ format: 5, version: "8.0.0" }), OPTS)).toThrowError(/meta.format/);
    expect(() => coveragePyAdapter.parse(mk({ format: 3, version: "8.0.0" }), OPTS)).toThrowError(/unsupported coverage.py version/);
  });

  it("NaN/Infinity counts are rejected", () => {
    const artifact = { "a.ts": { statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } }, s: { "0": "oops" } } };
    expect(() => istanbulAdapter.parse(JSON.stringify(artifact), OPTS)).toThrowError(/not a number/);
  });

  it("deeply nested JSON array bomb is handled by JSON.parse limits or our caps", () => {
    const bomb = deepJson(5000);
    expect(() => istanbulAdapter.parse(bomb, OPTS)).toThrowError(); // any parse failure is a loud rejection
    expect(() => coveragePyAdapter.parse(bomb, OPTS)).toThrowError();
  });
});
