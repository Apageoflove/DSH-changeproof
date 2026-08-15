/**
 * 工作区服务：有界文件扫描、指纹输入收集、基于子进程端口的 git runner。
 * 所有文件系统访问都走 FsPort。
 */
import path from "node:path";
import type { Digest, FingerprintInputs, ImpactCandidate } from "../shared/models.ts";
import { globMatch } from "../shared/schema.ts";
import type { FsPort } from "./adapters/dsh/fs-port.ts";
import { sha256Hex } from "./adapters/dsh/fs-port.ts";
import type { SubprocessPort } from "./adapters/dsh/subprocess-port.ts";
import { buildEnv } from "./execution/command-policy.ts";
import type { GitRunner } from "./adapters/git/changeset.ts";
import type { ChangeProofConfig } from "./config/schema.ts";
import type { ChangeSet } from "../shared/models.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".changeproof", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache"]);
const MAX_WORKSPACE_FILES = 30_000;
const MAX_SCAN_DEPTH = 24;

export interface WorkspaceScan {
  files: string[]; // workspace-relative POSIX
  truncated: boolean;
}

export async function scanWorkspaceFiles(fs: FsPort, rootAbs: string, config: ChangeProofConfig): Promise<WorkspaceScan> {
  const out: string[] = [];
  let truncated = false;
  const { readdir } = await import("node:fs/promises");

  const walk = async (relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (out.length >= MAX_WORKSPACE_FILES) {
      truncated = true;
      return;
    }
    const abs = relDir === "" ? rootAbs : path.join(rootAbs, ...relDir.split("/"));
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length >= MAX_WORKSPACE_FILES) {
        truncated = true;
        return;
      }
      const rel = relDir === "" ? d.name : `${relDir}/${d.name}`;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        await walk(rel, depth + 1);
      } else if (d.isFile()) {
        const included = config.packages.some((p) => p.include.some((g) => globMatch(g, rel)));
        // test files under a package root are candidates even when `include`
        // lists only sources — impact analysis needs them (documented in docs/configuration.md)
        const isTestUnderPackage = isTestFilePath(rel) &&
          config.packages.some((p) => (p.root === "" || rel.startsWith(p.root + "/")));
        const excluded = config.exclude.some((g) => globMatch(g, rel));
        if ((included || isTestUnderPackage) && !excluded) out.push(rel);
      }
    }
  };

  await walk("", 0);
  out.sort();
  return { files: out, truncated };
}

const LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Pipfile.lock"];
const RUNNER_CONFIG_NAMES = [
  "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.cts",
  "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs",
  "pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", ".coveragerc"
];
export const PLUGIN_CONFIG_REL = ".changeproof.yml";

export async function gatherFingerprintInputs(
  fs: FsPort,
  rootAbs: string,
  config: ChangeProofConfig,
  changeSet: ChangeSet,
  candidates: ImpactCandidate[],
  adapters: Array<{ id: string; version: string }>,
  scannedFiles: string[]
): Promise<FingerprintInputs> {
  const digestOf = async (rel: string): Promise<Digest | null> => {
    try {
      return await fs.digestFileNormalized(path.join(rootAbs, ...rel.split("/")), 20 * 1024 * 1024);
    } catch {
      return null;
    }
  };

  const changedFileDigests: FingerprintInputs["changedFileDigests"] = [];
  for (const f of changeSet.files) {
    if (f.contentDigest) changedFileDigests.push({ path: f.path, digest: f.contentDigest });
  }

  const testFiles = [...new Set(candidates.flatMap((c) => c.testFiles))];
  const testFileDigests: FingerprintInputs["testFileDigests"] = [];
  for (const t of testFiles) {
    const d = await digestOf(t);
    if (d) testFileDigests.push({ path: t, digest: d });
  }

  const roots = ["", ...config.packages.map((p) => p.root)];
  const tryDigest = async (names: string[], label: "lock" | "runner"): Promise<Array<{ path: string; digest: Digest }>> => {
    const found: Array<{ path: string; digest: Digest }> = [];
    for (const root of roots) {
      for (const name of names) {
        const rel = root === "" ? name : `${root}/${name}`;
        const d = await digestOf(rel);
        if (d) found.push({ path: rel, digest: d });
        void label;
      }
    }
    return found;
  };

  return {
    baselineCommit: changeSet.baseline.commit,
    changeSetDigest: changeSet.digest,
    changedFileDigests,
    testFileDigests,
    lockfileDigests: await tryDigest(LOCKFILE_NAMES, "lock"),
    runnerConfigDigests: await tryDigest(RUNNER_CONFIG_NAMES, "runner"),
    pluginConfigDigest: await digestOf(PLUGIN_CONFIG_REL),
    adapters
  };
}

/** Bounded cached reader for impact analysis (pre-warmed for sync access). */
export async function prewarmReader(fs: FsPort, rootAbs: string, files: string[]): Promise<(rel: string) => string | null> {
  const cache = new Map<string, string | null>();
  for (const rel of files) {
    try {
      const { bytes } = await fs.readFileBounded(path.join(rootAbs, ...rel.split("/")), 2 * 1024 * 1024);
      cache.set(rel, Buffer.from(bytes).toString("utf8"));
    } catch {
      cache.set(rel, null);
    }
  }
  return (rel: string) => cache.get(rel) ?? null;
}

export function makeGitRunner(subprocess: SubprocessPort, env: Record<string, string | undefined>): GitRunner {
  return async (argv, cwd) => {
    const res = await subprocess.execute({
      argv: ["git", ...argv],
      cwdAbs: cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 20 * 1024 * 1024,
      env: buildEnv(env)
    });
    return { code: res.exitCode ?? -1, stdout: res.stdout, stderr: res.stderr };
  };
}

export async function workspaceIdOf(fs: FsPort, rootAbs: string): Promise<Digest> {
  const { realpath } = await import("node:fs/promises");
  const real = await realpath(rootAbs).catch(() => rootAbs);
  return sha256Hex(real);
}

/** Mirrors impact-resolver.isTestFile without importing the analyzer (no cycles). */
function isTestFilePath(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel) ||
    /^test_.*\.py$/.test(base) ||
    /(^|\/)tests?\//.test(rel) ||
    /(^|\/)__tests__\//.test(rel)
  );
}
