/**
 * 删除行风险（PROJECT.md 8.7）：删除按文件记录，绝不计为已覆盖。
 * UI 需说明删除风险要靠相关测试 / 静态检查 / mutation 佐证。
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
