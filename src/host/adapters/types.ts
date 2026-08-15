/**
 * Coverage adapter contract shared by all language adapters.
 * Adapters turn a raw coverage artifact into executable/covered line sets
 * keyed by workspace-relative POSIX path. Parser problems must throw or be
 * reported as diagnostics — NEVER silently degraded to "pass".
 */
export interface CoverageArtifactParseOptions {
  workspaceRootAbs: string;
  maxFileEntries: number; // resource cap: number of file entries
  maxLinesPerFile: number; // resource cap: lines per file entry
}

export interface CoverageArtifact {
  /** path → executable line numbers (statement/fn/branch locations or executed∪missing). */
  executableByFile: Map<string, Set<number>>;
  /** path → covered line numbers (hit count > 0). */
  coveredByFile: Map<string, Set<number>>;
  diagnostics: string[];
}

export interface CoverageAdapter {
  readonly id: string;
  readonly version: string;
  /** Artifact kind used in EvidenceRecord.artifactDigests. */
  readonly artifactKind: string;
  parse(jsonText: string, opts: CoverageArtifactParseOptions): CoverageArtifact;
}

/** Normalize an artifact path key to workspace-relative POSIX (or null). */
export function normalizeArtifactPath(key: string, workspaceRootAbs: string): string | null {
  if (!key || key.includes("\0")) return null;
  const root = workspaceRootAbs.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = key.replace(/\\/g, "/").replace(/\/+$/, "");
  // strip istanbul-ish prefixes
  if (p.startsWith("a/")) p = p.slice(2);
  if (p.startsWith("b/")) p = p.slice(2);
  // absolute path inside the workspace?
  const rootLower = root.toLowerCase();
  if (p.toLowerCase().startsWith(rootLower + "/")) {
    return p.slice(root.length + 1);
  }
  // windows absolute with different casing / short path: try drive-relative match
  const m = p.match(/^[a-zA-Z]:\/(.*)$/);
  if (m) {
    const relCandidate = m[1]!;
    // only trust it when the root's tail matches (avoid C:\evil\... passthrough)
    const rootTail = root.split("/").slice(1).join("/").toLowerCase();
    if (rootTail.length > 0 && relCandidate.toLowerCase().startsWith(rootTail + "/")) {
      return relCandidate.slice(rootTail.length + 1);
    }
    return null;
  }
  if (p.startsWith("/")) return null; // absolute outside workspace
  // relative: strip leading ../ (outside) and ./ segments
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
