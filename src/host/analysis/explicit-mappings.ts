/**
 * `.changeproof.yml` 里的显式映射（经 schema + 路径边界校验后为 HIGH；
 * PROJECT.md 8.2 第 1 层）。
 */
import type { ImpactCandidate } from "../../shared/models.ts";
import { globMatch } from "../../shared/schema.ts";
import type { MappingConfig, PackageConfig } from "../config/schema.ts";

export function resolveExplicitMappings(
  changedPaths: string[],
  mappings: MappingConfig[],
  packages: PackageConfig[]
): ImpactCandidate[] {
  const candidates: ImpactCandidate[] = [];
  for (const mapping of mappings) {
    const affected = changedPaths.filter((p) => mapping.sources.some((g) => globMatch(g, p)));
    if (affected.length === 0) continue;
    const testFiles = mapping.tests; // globs; expansion happens against workspace list
    const pkg = packageForPath(packages, affected[0]!) ?? packages[0]!;
    candidates.push({
      schemaVersion: "1.0",
      id: `explicit:${mapping.sources.join(",")}`,
      packageId: pkg?.id ?? "unknown",
      testFiles: [...testFiles],
      argv: pkg ? [...pkg.test.argv] : [],
      cwd: pkg ? pkg.test.cwd : "",
      source: "explicit",
      confidence: mapping.confidence,
      affectedFiles: affected,
      rationale: [
        `explicit mapping in .changeproof.yml: sources [[${mapping.sources.join(", ")}]] → tests [[${mapping.tests.join(", ")}]]`,
        "user-declared mapping is exhaustive for the matched sources"
      ]
    });
  }
  return candidates;
}

/** Find the package whose include globs match a workspace-relative path. */
export function packageForPath(packages: PackageConfig[], path: string): PackageConfig | undefined {
  return packages.find(
    (p) =>
      p.include.some((g) => globMatch(g, path)) ||
      // a repo-root package (root: "") owns the whole workspace
      p.root === "" ||
      (path === p.root || path.startsWith(p.root + "/"))
  );
}
