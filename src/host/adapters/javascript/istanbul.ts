/**
 * Istanbul `coverage-final.json` 适配器（vitest/jest 的 istanbul provider）。
 * 可执行行来自 statementMap/fnMap/branchMap；覆盖行要求 s/f/b 计数 > 0。
 * 结构不符就是解析错误，绝不猜（PROJECT.md 8.7）。
 */
import { CpError } from "../../../shared/errors.ts";
import { isPlainObject } from "../../../shared/schema.ts";
import { normalizeArtifactPath, type CoverageAdapter, type CoverageArtifact, type CoverageArtifactParseOptions } from "../types.ts";

interface Loc {
  start: { line: number; column?: number };
  end: { line: number; column?: number };
}

function parseLoc(raw: unknown, ctx: string): Loc {
  if (!isPlainObject(raw) || !isPlainObject(raw["start"]) || !isPlainObject(raw["end"])) {
    throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: location must have start/end objects`);
  }
  const sl = Number(raw["start"]["line"]);
  const el = Number(raw["end"]["line"]);
  if (!Number.isInteger(sl) || !Number.isInteger(el) || sl < 1 || el < sl || el - sl > 100_000) {
    throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: invalid line numbers (start ${sl}, end ${el})`);
  }
  return { start: { line: sl }, end: { line: el } };
}

function addRange(set: Set<number>, loc: Loc, maxLines: number, ctx: string): void {
  if (loc.end.line - loc.start.line + 1 > maxLines) {
    throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `${ctx}: location spans ${loc.end.line - loc.start.line + 1} lines (cap ${maxLines}); refusing to guess`);
  }
  for (let ln = loc.start.line; ln <= loc.end.line; ln += 1) set.add(ln);
}

export class IstanbulAdapter implements CoverageAdapter {
  readonly id = "istanbul";
  readonly version = "1.0";
  readonly artifactKind = "istanbul-json";

  parse(jsonText: string, opts: CoverageArtifactParseOptions): CoverageArtifact {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(parsed)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "istanbul artifact root must be an object keyed by file path");
    }
    const entries = Object.keys(parsed);
    if (entries.length > opts.maxFileEntries) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `istanbul artifact has ${entries.length} file entries (cap ${opts.maxFileEntries})`);
    }

    const executableByFile = new Map<string, Set<number>>();
    const coveredByFile = new Map<string, Set<number>>();
    const diagnostics: string[] = [];

    for (const [key, rawFile] of Object.entries(parsed)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul artifact contains forbidden key "${key}"`);
      }
      const path = normalizeArtifactPath(key, opts.workspaceRootAbs);
      if (!path) {
        diagnostics.push(`skipping artifact entry outside workspace: ${key.slice(0, 120)}`);
        continue;
      }
      if (!isPlainObject(rawFile)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul entry for ${path} must be an object`);
      }
      const ctx = `istanbul[${path}]`;
      const statementMap = rawFile["statementMap"];
      const fnMap = rawFile["fnMap"] ?? {};
      const branchMap = rawFile["branchMap"] ?? {};
      const s = rawFile["s"];
      const f = (rawFile["f"] ?? {}) as Record<string, unknown>;
      const b = (rawFile["b"] ?? {}) as Record<string, unknown>;
      if (!isPlainObject(statementMap) || !isPlainObject(s)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: statementMap and s counters are required`);
      }

      const executable = new Set<number>();
      const covered = new Set<number>();

      // statements
      for (const [idx, locRaw] of Object.entries(statementMap)) {
        if (idx === "__proto__") continue;
        const loc = parseLoc(locRaw, `${ctx}.statementMap[${idx}]`);
        addRange(executable, loc, opts.maxLinesPerFile, `${ctx}.statementMap[${idx}]`);
        const count = s[idx];
        if (count === undefined || !isCountKey(idx, s)) continue;
        const n = Number(count);
        if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.s[${idx}] is not a number`);
        if (n > 0) addRange(covered, loc, opts.maxLinesPerFile, `${ctx}.statementMap[${idx}]`);
      }
      // functions: only the START line is an executable/hit unit (Istanbul semantics)
      if (isPlainObject(fnMap)) {
        for (const [idx, rawFn] of Object.entries(fnMap)) {
          if (idx === "__proto__" || !isPlainObject(rawFn)) continue;
          const locRaw = rawFn["loc"] ?? rawFn["decl"];
          if (locRaw === undefined) continue;
          const loc = parseLoc(locRaw, `${ctx}.fnMap[${idx}]`);
          executable.add(loc.start.line);
          const n = Number(f[idx] ?? 0);
          if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.f[${idx}] is not a number`);
          if (n > 0) covered.add(loc.start.line);
        }
      }
      // branches: each branch location contributes its START line
      if (isPlainObject(branchMap)) {
        for (const [idx, rawBranch] of Object.entries(branchMap)) {
          if (idx === "__proto__" || !isPlainObject(rawBranch)) continue;
          const rawLocs = rawBranch["locations"];
          if (!Array.isArray(rawLocs)) continue;
          const counts = b[idx];
          if (!Array.isArray(counts) || counts.length !== rawLocs.length) {
            throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.b[${idx}] must parallel branchMap locations`);
          }
          rawLocs.forEach((locRaw, j) => {
            if (locRaw === null || locRaw === undefined) return;
            const loc = parseLoc(locRaw, `${ctx}.branchMap[${idx}][${j}]`);
            executable.add(loc.start.line);
            const n = Number(counts[j]);
            if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.b[${idx}][${j}] is not a number`);
            if (n > 0) covered.add(loc.start.line);
          });
        }
      }

      executableByFile.set(path, executable);
      coveredByFile.set(path, covered);
    }

    return { executableByFile, coveredByFile, diagnostics };
  }
}

function isCountKey(idx: string, s: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(s, idx);
}

export const istanbulAdapter = new IstanbulAdapter();
