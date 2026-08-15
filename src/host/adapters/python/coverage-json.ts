/**
 * coverage.py JSON adapter (pytest --cov-report=json).
 * Executable lines = executed ∪ missing (minus excluded). Unknown
 * meta.format/version fails loud (PROJECT.md 8.7).
 */
import { CpError } from "../../../shared/errors.ts";
import { isPlainObject } from "../../../shared/schema.ts";
import { normalizeArtifactPath, type CoverageAdapter, type CoverageArtifact, type CoverageArtifactParseOptions } from "../types.ts";

/**
 * coverage.py JSON format (verified against coverage 7.15.4, format version 3):
 *   meta: { format: 3, version: "7.15.4", timestamp, branch_coverage, show_contexts }
 *   files: { "<os-separator path>": { executed_lines, missing_lines, excluded_lines, summary } }
 * Format numbers other than the pinned set fail loud.
 */
const SUPPORTED_JSON_FORMAT = 3;
const SUPPORTED_COVERAGE_VERSIONS = ["6.", "7."];

export class CoveragePyAdapter implements CoverageAdapter {
  readonly id = "coverage-py";
  readonly version = "1.0";
  readonly artifactKind = "coverage-py-json";

  parse(jsonText: string, opts: CoverageArtifactParseOptions): CoverageArtifact {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(parsed)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "coverage.py artifact root must be an object");
    }
    const meta = parsed["meta"];
    if (!isPlainObject(meta) || meta["format"] !== SUPPORTED_JSON_FORMAT || typeof meta["version"] !== "string") {
      throw new CpError(
        "CP_COVERAGE_SCHEMA_UNKNOWN",
        `coverage.py artifact must declare meta.format=${SUPPORTED_JSON_FORMAT} with a string meta.version (got ${JSON.stringify((meta as Record<string, unknown>)["format"])})`
      );
    }
    const version = meta["version"] as string;
    if (!SUPPORTED_COVERAGE_VERSIONS.some((p) => version.startsWith(p))) {
      throw new CpError("CP_COVERAGE_SCHEMA_UNKNOWN", `unsupported coverage.py version "${version}" (supported: 6.x, 7.x with JSON format ${SUPPORTED_JSON_FORMAT}) — refusing to guess fields`);
    }
    const files = parsed["files"];
    if (!isPlainObject(files)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "coverage.py artifact must contain a files mapping");
    }
    const entries = Object.keys(files);
    if (entries.length > opts.maxFileEntries) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage.py artifact has ${entries.length} file entries (cap ${opts.maxFileEntries})`);
    }

    const executableByFile = new Map<string, Set<number>>();
    const coveredByFile = new Map<string, Set<number>>();
    const diagnostics: string[] = [];

    for (const [key, raw] of Object.entries(files)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py artifact contains forbidden key "${key}"`);
      }
      const path = normalizeArtifactPath(key, opts.workspaceRootAbs);
      if (!path) {
        diagnostics.push(`skipping artifact entry outside workspace: ${key.slice(0, 120)}`);
        continue;
      }
      if (!isPlainObject(raw)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path} must be an object`);
      }
      const executed = raw["executed_lines"];
      const missing = raw["missing_lines"];
      const excluded = raw["excluded_lines"] ?? [];
      if (!Array.isArray(executed) || !Array.isArray(missing) || !Array.isArray(excluded)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path}: executed_lines/missing_lines must be arrays`);
      }
      const toLines = (arr: unknown[], field: string): Set<number> => {
        const out = new Set<number>();
        for (const v of arr) {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 10_000_000) {
            throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path}: ${field} contains invalid line ${JSON.stringify(v)}`);
          }
          out.add(n);
        }
        if (out.size > opts.maxLinesPerFile) {
          throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage.py entry for ${path}: ${field} exceeds ${opts.maxLinesPerFile} lines`);
        }
        return out;
      };
      const executedSet = toLines(executed, "executed_lines");
      const missingSet = toLines(missing, "missing_lines");
      const excludedSet = toLines(excluded, "excluded_lines");

      const executable = new Set<number>([...executedSet, ...missingSet]);
      for (const ex of excludedSet) executable.delete(ex);
      executableByFile.set(path, executable);
      const covered = new Set<number>();
      for (const ln of executedSet) {
        if (!excludedSet.has(ln)) covered.add(ln);
      }
      coveredByFile.set(path, covered);
    }

    return { executableByFile, coveredByFile, diagnostics };
  }
}

export const coveragePyAdapter = new CoveragePyAdapter();
