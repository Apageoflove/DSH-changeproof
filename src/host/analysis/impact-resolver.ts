/**
 * 影响解析器：按固定优先级合并四级候选来源（PROJECT.md 8.2）。
 * 显式 > 历史 map > import-graph > 命名。候选按 (package, 测试集) 合并，
 * 保留各来源与理由，置信度取最高可信值。verdict 用 maxConfidence；
 * 只有 LOW 置信度时不能声称穷尽。
 */
import type { Confidence, ImpactCandidate } from "../../shared/models.ts";
import { globMatch } from "../../shared/schema.ts";
import type { ChangeProofConfig, PackageConfig } from "../config/schema.ts";
import { buildJsImportGraph, reverseReachable as jsReverse } from "../adapters/javascript/import-graph.ts";
import { buildPythonImportGraph, reverseReachable as pyReverse } from "../adapters/python/import-graph.ts";
import { resolveExplicitMappings, packageForPath } from "./explicit-mappings.ts";
import { namingConventionCandidates } from "./naming-conventions.ts";
import { matchHistoryEntries, type HistoryEntry } from "./history-map.ts";

export interface ImpactResolutionInputs {
  changedFiles: Array<{ path: string; contentDigest: string | null }>;
  workspaceFiles: string[]; // all candidate source/test files (already filtered by include/exclude)
  readWorkspaceFile(relPath: string): string | null;
  config: ChangeProofConfig;
  historyEntries: HistoryEntry[];
  nowIso: string;
}

export interface ImpactResolution {
  candidates: ImpactCandidate[];
  maxConfidence: Confidence;
  diagnostics: string[];
  /** Files for which NO candidate source produced anything. */
  unresolvedPaths: string[];
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export function resolveImpact(inputs: ImpactResolutionInputs): ImpactResolution {
  const { config, workspaceFiles } = inputs;
  const changedPaths = inputs.changedFiles.map((f) => f.path);
  const diagnostics: string[] = [];
  const merged = new Map<string, ImpactCandidate>();

  const addCandidate = (cand: ImpactCandidate) => {
    const key = `${cand.packageId}::${[...cand.testFiles].sort().join("|")}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...cand, affectedFiles: [...new Set(cand.affectedFiles)], rationale: [...cand.rationale] });
      return;
    }
    // merge: keep highest confidence, union affected files, append sources to rationale
    if (CONFIDENCE_ORDER[cand.confidence] > CONFIDENCE_ORDER[existing.confidence]) {
      existing.confidence = cand.confidence;
    }
    existing.affectedFiles = [...new Set([...existing.affectedFiles, ...cand.affectedFiles])];
    existing.rationale.push(...cand.rationale);
    if (!existing.rationale.some((r) => r.startsWith(`sources: `))) {
      existing.rationale.push(`sources: ${cand.source}`);
    }
  };

  const jsChanged = changedPaths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
  const pyChanged = changedPaths.filter((p) => p.endsWith(".py"));

  // tier 1: explicit mappings (HIGH)
  for (const cand of resolveExplicitMappings(changedPaths, config.mappings, config.packages)) {
    // expand test globs against the real workspace file list
    const expanded = expandTestGlobs(cand.testFiles, workspaceFiles);
    if (expanded.length === 0) {
      diagnostics.push(`explicit mapping matched sources but no test files exist for [[${cand.testFiles.join(", ")}]]`);
      continue;
    }
    addCandidate({ ...cand, testFiles: expanded });
  }

  // tier 2: history coverage map (HIGH on digest match, MEDIUM on drift)
  const historyMatches = matchHistoryEntries(
    inputs.changedFiles.map((f) => ({ path: f.path, contentDigest: f.contentDigest as never })),
    inputs.historyEntries,
    inputs.nowIso,
    config.coverage.historyMap.enabled ? config.coverage.historyMap.maxAgeDays : 0
  );
  const historyByPath = new Map(historyMatches.map((m) => [m.path, m]));
  const historyCovered = changedPaths.filter((p) => historyByPath.has(p));
  for (const pkg of config.packages) {
    const affected = historyCovered.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
    if (affected.length === 0) continue;
    const tests = [...new Set(affected.flatMap((p) => historyByPath.get(p)!.testFiles))];
    if (tests.length === 0) continue;
    const anyHigh = affected.some((p) => historyByPath.get(p)!.confidence === "HIGH");
    addCandidate({
      schemaVersion: "1.0",
      id: `history:${pkg.id}`,
      packageId: pkg.id,
      testFiles: tests,
      argv: [...pkg.test.argv],
      cwd: pkg.test.cwd,
      source: "coverage-history",
      confidence: anyHigh ? "HIGH" : "MEDIUM",
      affectedFiles: affected,
      rationale: [
        `historical coverage-map match for [[${affected.join(", ")}]] (${anyHigh ? "digest match" : "digest drift"})`,
        anyHigh
          ? "map digests + adapter version still valid: HIGH"
          : "source digest drifted since the map was recorded: MEDIUM"
      ]
    });
  }

  // tier 3: static import graph (default MEDIUM; dynamic/unresolved lowers completeness)
  if (jsChanged.length > 0) {
    const graph = buildJsImportGraph(workspaceFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)), inputs.readWorkspaceFile);
    diagnostics.push(...graph.diagnostics);
    const importers = jsReverse(graph, jsChanged);
    // A changed-but-existing test file is a valid candidate itself (new/modified
    // tests). Deleted test files are NOT in graph.edges and stay excluded.
    const changedExistingTests = jsChanged.filter((f) => graph.edges.has(f) && isTestFile(f));
    const allTests = [...new Set([...importers, ...changedExistingTests])];
    for (const pkg of config.packages) {
      if (!pkg.languages.some((l) => l === "typescript" || l === "javascript")) continue;
      const tests = allTests.filter(
        (f) => isTestFile(f) && packageForPath(config.packages, f)?.id === pkg.id
      );
      const affected = jsChanged.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
      if (tests.length === 0 || affected.length === 0) continue;
      const completenessHit = [...importers].some((f) => graph.incompleteFiles.has(f));
      addCandidate({
        schemaVersion: "1.0",
        id: `import-graph:${pkg.id}`,
        packageId: pkg.id,
        testFiles: tests.sort(),
        argv: [...pkg.test.argv],
        cwd: pkg.test.cwd,
        source: "import-graph",
        confidence: "MEDIUM",
        affectedFiles: affected,
        rationale: [
          `static import graph: [[${tests.join(", ")}]] transitively imports changed modules`,
          completenessHit
            ? "completeness reduced: dynamic imports or unresolved specifiers present"
            : "all static imports resolved"
        ]
      });
    }
  }
  if (pyChanged.length > 0) {
    for (const pkg of config.packages) {
      if (!pkg.languages.includes("python")) continue;
      const graph = buildPythonImportGraph(workspaceFiles.filter((f) => f.endsWith(".py")), inputs.readWorkspaceFile, { roots: [pkg.root] });
      diagnostics.push(...graph.diagnostics);
      const importers = pyReverse(graph, pyChanged);
      const changedExistingTests = pyChanged.filter((f) => graph.edges.has(f) && isTestFile(f));
      const tests = [...new Set([...importers, ...changedExistingTests])].filter(
        (f) => isTestFile(f) && packageForPath(config.packages, f)?.id === pkg.id
      );
      const affected = pyChanged.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
      if (tests.length === 0 || affected.length === 0) continue;
      addCandidate({
        schemaVersion: "1.0",
        id: `import-graph:${pkg.id}`,
        packageId: pkg.id,
        testFiles: tests.sort(),
        argv: [...pkg.test.argv],
        cwd: pkg.test.cwd,
        source: "import-graph",
        confidence: "MEDIUM",
        affectedFiles: affected,
        rationale: ["static import graph: tests importing changed python modules", "python namespace packages may reduce completeness"]
      });
    }
  }

  // tier 4: naming conventions (LOW)
  for (const cand of namingConventionCandidates(changedPaths, workspaceFiles, config.packages)) {
    addCandidate(cand);
  }

  const candidates = [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const covered = new Set(candidates.flatMap((c) => c.affectedFiles));
  const unresolvedPaths = changedPaths.filter((p) => !covered.has(p));
  if (unresolvedPaths.length > 0) {
    diagnostics.push(`no impact candidates resolved for: [[${unresolvedPaths.join(", ")}]]`);
  }

  const maxConfidence = candidates.reduce<Confidence>((max, c) => {
    return CONFIDENCE_ORDER[c.confidence] > CONFIDENCE_ORDER[max] ? c.confidence : max;
  }, "LOW");

  return { candidates, maxConfidence, diagnostics, unresolvedPaths };
}

function expandTestGlobs(globs: string[], workspaceFiles: string[]): string[] {
  const out = new Set<string>();
  for (const g of globs) {
    for (const f of workspaceFiles) {
      if (globMatch(g, f)) out.add(f);
    }
  }
  return [...out].sort();
}

export function isTestFile(path: string): boolean {
  const base = path.split("/").pop()!;
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) ||
    /^test_.*\.py$/.test(base) ||
    /(^|\/)tests?\//.test(path) ||
    /(^|\/)__tests__\//.test(path)
  );
}
