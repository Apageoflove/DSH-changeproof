/**
 * 改动行覆盖分析（PROJECT.md 8.7）。
 * 分母 = adapter 可靠识别为可执行的新增/修改行。注释、空行不计
 * （不在 statement/fn/branch map 里）。删除行不进分母，记为删除风险。
 */
import type { ChangedFile, ChangeSet } from "../../shared/models.ts";
import type { FileCoverage } from "../../shared/models.ts";
import { globMatch } from "../../shared/schema.ts";

export interface ChangedLinesResult {
  files: FileCoverage[];
  coverableTotal: number;
  coveredTotal: number;
  uncoveredTotal: number;
  ratio: number | null;
  /** Files whose changes exist but that are entirely absent from the artifact. */
  gapFiles: string[];
  excludedFiles: Array<{ path: string; rule: string }>;
}

/** Compute changed-line coverage from adapter-provided executable/covered sets. */
export function analyzeChangedLineCoverage(
  changeSet: ChangeSet,
  executableByFile: Map<string, Set<number>>,
  coveredByFile: Map<string, Set<number>>,
  excludeGlobs: string[]
): ChangedLinesResult {
  const files: FileCoverage[] = [];
  const excludedFiles: Array<{ path: string; rule: string }> = [];

  for (const f of changeSet.files) {
    if (f.status === "deleted") continue;
    const excludedBy = excludeGlobs.find((g) => globMatch(g, f.path));
    if (excludedBy !== undefined) {
      excludedFiles.push({ path: f.path, rule: excludedBy });
      files.push({ path: f.path, coverable: [], covered: [], uncovered: [], absentFromArtifact: false, excluded: excludedBy });
      continue;
    }
    const executableLines = executableByFile.get(f.path);
    if (!executableLines) {
      files.push({ path: f.path, coverable: [], covered: [], uncovered: [], absentFromArtifact: true });
      continue;
    }
    const coveredLines = coveredByFile.get(f.path) ?? new Set<number>();
    const coverable: number[] = [];
    for (const range of f.ranges) {
      if (range.kind === "deleted") continue;
      for (let ln = range.startLine; ln <= range.endLine; ln += 1) {
        if (executableLines.has(ln)) coverable.push(ln);
      }
    }
    const unique = [...new Set(coverable)].sort((a, b) => a - b);
    const covered = unique.filter((ln) => coveredLines.has(ln));
    files.push({
      path: f.path,
      coverable: unique,
      covered,
      uncovered: unique.filter((ln) => !coveredLines.has(ln)),
      absentFromArtifact: false
    });
  }

  return finalize(files, excludedFiles);
}

function finalize(files: FileCoverage[], excludedFiles: Array<{ path: string; rule: string }>): ChangedLinesResult {
  const inDenominator = files.filter((f) => !f.excluded);
  const coverableTotal = inDenominator.reduce((n, f) => n + f.coverable.length, 0);
  const coveredTotal = inDenominator.reduce((n, f) => n + f.covered.length, 0);
  const gapFiles = inDenominator
    .filter((f) => f.absentFromArtifact && hasContentChange(f))
    .map((f) => f.path);
  return {
    files,
    coverableTotal,
    coveredTotal,
    uncoveredTotal: coverableTotal - coveredTotal,
    ratio: coverableTotal > 0 ? coveredTotal / coverableTotal : null,
    gapFiles,
    excludedFiles
  };
}

function hasContentChange(f: FileCoverage): boolean {
  // A file absent from the artifact is only a gap when it has non-deleted
  // changed ranges at all (ranges info is mirrored onto FileCoverage.coverable
  // being empty — so we rely on the changeSet side via coverable===[] plus
  // absentFromArtifact; gap determination needs the original ranges).
  return f.absentFromArtifact; // caller combines with changeSet knowledge
}

/** True when the ChangeSet contains no non-deleted changed ranges at all. */
export function hasNoContentChanges(files: ChangedFile[]): boolean {
  return files.every((f) => f.status === "deleted" || f.ranges.every((r) => r.kind === "deleted"));
}

/** True when every content change is deletions only. */
export function isDeletionOnly(files: ChangedFile[]): boolean {
  const content = files.filter((f) => f.status !== "deleted");
  return (
    files.some((f) => f.linesDeleted > 0) &&
    content.every((f) => f.ranges.every((r) => r.kind === "deleted"))
  );
}
