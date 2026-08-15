/**
 * Deleted-line risk (PROJECT.md 8.7): deletions are recorded per file/symbol
 * neighborhood; they are never counted as covered. UI must show that deleted
 * risk relies on related tests / static checks / mutation smoke.
 */
import type { ChangedFile } from "../../shared/models.ts";

export interface DeletedRiskEntry {
  path: string;
  ranges: string[];
}

export function deletedLineRiskOf(files: ChangedFile[]): DeletedRiskEntry[] {
  return files
    .filter((f) => f.linesDeleted > 0)
    .map((f) => ({
      path: f.path,
      ranges: f.ranges.filter((r) => r.kind === "deleted").map((r) => `${r.startLine}-${r.endLine}`)
    }));
}
