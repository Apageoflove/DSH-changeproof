/**
 * 命名约定的影响候选（LOW 置信度；PROJECT.md 8.2 第 4 层）。
 * LOW 只产出候选，绝不声称穷尽。
 */
import type { ImpactCandidate } from "../../shared/models.ts";
import type { PackageConfig } from "../config/schema.ts";
import { packageForPath } from "./explicit-mappings.ts";

export interface WorkspaceFileList {
  /** all workspace-relative POSIX paths (already filtered by include/exclude upstream) */
  all(): string[];
}

/**
 * JS conventions: src/foo.ts ↔ foo.test.ts / foo.spec.ts / __tests__/foo.ts /
 * tests/foo.test.ts. Python: mod.py ↔ test_mod.py / tests/test_mod.py.
 * Returns candidate test FILES that actually exist in the workspace.
 */
export function namingConventionCandidates(
  changedPaths: string[],
  workspaceFiles: string[],
  packages: PackageConfig[]
): ImpactCandidate[] {
  const fileSet = new Set(workspaceFiles);
  const byCandidate = new Map<string, ImpactCandidate>();

  for (const changed of changedPaths) {
    const pkg = packageForPath(packages, changed);
    if (!pkg) continue;
    const isPython = changed.endsWith(".py");
    const isJs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(changed);
    if (!isPython && !isJs) continue;

    const dir = changed.split("/").slice(0, -1).join("/");
    const base = changed.split("/").pop()!;
    const tests: string[] = [];

    if (isJs) {
      const stem = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
      const ext = base.slice(stem.length); // keep original extension preference order
      const variants = [
        ...(dir ? [`${dir}/${stem}.test${ext}`] : [`${stem}.test${ext}`]),
        ...(dir ? [`${dir}/${stem}.spec${ext}`] : [`${stem}.spec${ext}`]),
        ...(dir ? [`${dir}/__tests__/${stem}${ext}`, `${dir}/__tests__/${stem}.test${ext}`] : [`__tests__/${stem}${ext}`, `__tests__/${stem}.test${ext}`]),
        ...(dir ? [`${dir.replace(/\/src$/, "")}/tests/${stem}.test${ext}`] : [`tests/${stem}.test${ext}`])
      ];
      for (const v of variants) if (fileSet.has(v)) tests.push(v);
    } else {
      const stem = base.replace(/\.py$/, "");
      const variants = [
        ...(dir ? [`${dir}/test_${stem}.py`] : [`test_${stem}.py`]),
        ...(dir ? [`${dir}/tests/test_${stem}.py`] : [`tests/test_${stem}.py`])
      ];
      for (const v of variants) if (fileSet.has(v)) tests.push(v);
    }

    if (tests.length === 0) continue;
    const key = `${pkg.id}::${tests.join(",")}`;
    const existing = byCandidate.get(key);
    if (existing) {
      existing.affectedFiles.push(changed);
      continue;
    }
    byCandidate.set(key, {
      schemaVersion: "1.0",
      id: `naming:${key}`,
      packageId: pkg.id,
      testFiles: tests,
      argv: [...pkg.test.argv],
      cwd: pkg.test.cwd,
      source: "naming",
      confidence: "LOW",
      affectedFiles: [changed],
      rationale: [
        `naming convention match: ${changed} → [[${tests.join(", ")}]]`,
        "LOW confidence: naming conventions find candidates, they cannot prove exhaustiveness"
      ]
    });
  }

  return [...byCandidate.values()];
}
