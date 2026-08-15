/**
 * Static import graph for Python (from X import ... / import X).
 * Resolves dotted module names to files within the package root; dynamic
 * imports (__import__, importlib) mark the file incomplete (MEDIUM ceiling).
 */
export interface ImportGraphResult {
  edges: Map<string, Set<string>>;
  incompleteFiles: Set<string>;
  diagnostics: string[];
}

export interface PythonGraphOptions {
  /** Package roots (workspace-relative, e.g. "services/api") used to resolve absolute module names. */
  roots: string[];
}

export function buildPythonImportGraph(files: string[], read: (p: string) => string | null, options: PythonGraphOptions): ImportGraphResult {
  const edges = new Map<string, Set<string>>();
  const incompleteFiles = new Set<string>();
  const diagnostics: string[] = [];

  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const imports = new Set<string>();
    let hasDynamic = false;

    const fromRe = /^\s*from\s+([.\w]+)\s+import/gm;
    const importRe = /^\s*import\s+([\w.]+)/gm;
    const dynamicRe = /__import__\s*\(|importlib\.(import_module|util\.exec_module)/g;
    if (dynamicRe.test(text)) hasDynamic = true;

    for (const m of text.matchAll(fromRe)) {
      const mod = m[1]!;
      const resolved = resolvePythonModule(mod, file, read, options.roots);
      if (resolved) imports.add(resolved);
      else if (mod.startsWith(".")) {
        incompleteFiles.add(file);
        diagnostics.push(`unresolved relative import "${mod}" in ${file}`);
      }
    }
    for (const m of text.matchAll(importRe)) {
      const mod = m[1]!;
      const resolved = resolvePythonModule(mod, file, read, options.roots);
      if (resolved) imports.add(resolved);
      // absolute stdlib/pip imports resolve to nothing inside the workspace: fine
    }
    if (hasDynamic) {
      incompleteFiles.add(file);
      diagnostics.push(`dynamic import machinery in ${file} (__import__/importlib)`);
    }
    edges.set(file, imports);
  }

  return { edges, incompleteFiles, diagnostics };
}

function resolvePythonModule(mod: string, importer: string, read: (p: string) => string | null, roots: string[]): string | null {
  const parts = mod.split(".");
  while (parts[0] === "") parts.shift();
  if (parts[0] === ".") {
    // relative import: resolve against the importer's directory
    const stack = importer.split("/").slice(0, -1);
    let leadingDots = 0;
    while (parts[0] === "." && leadingDots < 16) {
      parts.shift();
      leadingDots += 1;
      if (leadingDots > 1) stack.pop();
    }
    for (const part of parts) stack.push(part);
    return tryPaths(stack.join("/"), read);
  }
  // absolute import: try each package root (sys.path-like resolution)
  for (const root of roots) {
    const found = tryPaths([root, ...parts].join("/"), read);
    if (found) return found;
  }
  return null;
}

function tryPaths(joined: string, read: (p: string) => string | null): string | null {
  const base = joined.replace(/^\/+/, ""); // repo-root packages produce no leading slash
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
    if (read(cand) !== null) return cand;
  }
  return null;
}

/**
 * Reverse-reachable importers of `targets`. The targets themselves are NOT
 * part of the result (a deleted/changed file is never its own importer).
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
