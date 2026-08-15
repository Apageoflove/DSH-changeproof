/**
 * Static import graph for JS/TS (default MEDIUM confidence; dynamic imports
 * and unresolved aliases downgrade completeness explicitly — PROJECT.md 8.2).
 * Pure analysis over injected file readers: no fs access here.
 */
export interface FileReaderPort {
  /** workspace-relative POSIX path → text content, or null when missing. */
  read(relPath: string): string | null;
  /** List workspace-relative paths under a prefix (globs already applied upstream). */
  list(prefix: string): string[];
}

export interface ImportGraphResult {
  /** importer → imported (workspace-relative) edges. */
  edges: Map<string, Set<string>>;
  /** Files whose imports could not be fully resolved (dynamic/alias). */
  incompleteFiles: Set<string>;
  diagnostics: string[];
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function buildJsImportGraph(files: string[], read: (p: string) => string | null): ImportGraphResult {
  const edges = new Map<string, Set<string>>();
  const incompleteFiles = new Set<string>();
  const diagnostics: string[] = [];

  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const imports = new Set<string>();
    const dynamicImports: string[] = [];

    // static imports / re-exports / require
    const staticRe = /(?:import|export)[^'"\n;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    // dynamic imports
    const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const m of text.matchAll(dynamicRe)) {
      dynamicImports.push(m[1]!);
    }
    const dynamicSpecs = new Set(dynamicImports);
    for (const m of text.matchAll(staticRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (dynamicSpecs.has(spec)) continue; // counted as dynamic below
      const resolved = resolveRelative(spec, file, read);
      if (resolved) imports.add(resolved);
      else if (!spec.startsWith(".")) {
        // bare specifier: package dependency or path alias — mark incompleteness
        incompleteFiles.add(file);
      } else {
        incompleteFiles.add(file);
        diagnostics.push(`unresolved relative import "${spec}" in ${file}`);
      }
    }
    for (const spec of dynamicSpecs) {
      incompleteFiles.add(file); // dynamic imports cannot be statically guaranteed
      const resolved = resolveRelative(spec, file, read);
      if (resolved) imports.add(resolved);
    }
    if (dynamicSpecs.size > 0) diagnostics.push(`dynamic import(s) in ${file}: [[${[...dynamicSpecs].join(", ")}]]`);
    edges.set(file, imports);
  }

  return { edges, incompleteFiles, diagnostics };
}

function resolveRelative(spec: string, importer: string, read: (p: string) => string | null): string | null {
  if (!spec.startsWith(".")) return null;
  const base = importer.split("/").slice(0, -1);
  const parts = spec.split("/");
  const stack = [...base];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = stack.join("/");
  const candidates = [
    joined,
    ...RESOLVE_EXTENSIONS.map((ext) => joined + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${joined}/index${ext}`)
  ];
  for (const cand of candidates) {
    if (read(cand) !== null) return cand;
  }
  return null;
}

/**
 * Reverse-reachable set: files that (transitively) IMPORT `targets`.
 * The targets themselves are NOT part of the result — a deleted or changed
 * file must never appear as its own "importer" (impact candidate pollution).
 */
export function reverseReachable(graph: ImportGraphResult, targets: string[]): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to)!.add(from);
    }
  }
  const targetSet = new Set(targets);
  const seen = new Set<string>();
  const queue = [...targets];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of reverse.get(cur) ?? []) queue.push(next);
  }
  const importers = new Set<string>();
  for (const f of seen) {
    if (!targetSet.has(f)) importers.add(f);
  }
  return importers;
}
