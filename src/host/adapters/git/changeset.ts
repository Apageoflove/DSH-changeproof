/**
 * 从 Git 构建变更集（PROJECT.md 8.1）。
 * 所有 git 调用都用受控 argv（绝不拼 shell 字符串）。未跟踪文件只有在
 * 匹配 package 的 include glob 时才纳入（open question #4 保守处理）。
 */
import { CpError } from "../../../shared/errors.ts";
import type { ChangedFile, ChangeSet, Digest, FileStatus } from "../../../shared/models.ts";
import { canonicalJsonStringify, globMatch } from "../../../shared/schema.ts";
import { parseUnifiedDiff, type FileDiff } from "./diff-parser.ts";

export type GitRunner = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DigestFn {
  (absPath: string): Promise<Digest | null>;
}

export interface BuildChangeSetOptions {
  workspaceRootAbs: string;
  /** Paths (workspace-relative, POSIX) that an untracked file must match to be included. */
  untrackedIncludeGlobs: string[];
  baselineKind: "head" | "merge-base";
  mergeBaseRef?: string;
  runGit: GitRunner;
  digestFile: DigestFn;
  workspaceId: Digest;
  /** Canonical-JSON hash fn (sha256Hex from the fs port keeps this module crypto-free). */
  hashCanonical: (s: string) => Digest;
}

const GIT_COMMON = ["-c", "core.quotepath=false", "-c", "core.safecrlf=false"];

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

interface PorcelainEntry {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
}

function parsePorcelain(raw: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const parts = raw.split("\0").filter((s) => s.length > 0);
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx]!;
    if (part.length < 4) continue;
    const x = part[0]!;
    const y = part[1]!;
    const pathRaw = part.slice(3);
    if (x === "R" || x === "C") {
      // rename/copy: the OLD path follows as the next NUL-delimited record
      const oldPath = parts[idx + 1] ?? "";
      idx += 1;
      entries.push({ path: pathRaw, oldPath, x, y });
    } else {
      entries.push({ path: pathRaw, x, y });
    }
  }
  return entries;
}

function statusFromDiff(fd: FileDiff, porcelain: PorcelainEntry | undefined): FileStatus {
  if (fd.status === "added") return porcelain?.x === "A" ? "added" : "untracked";
  if (fd.status === "deleted") return "deleted";
  if (fd.status === "renamed") return "renamed";
  if (porcelain?.x === "A") return "added";
  return "modified";
}

function digestOfChangeSet(cs: Omit<ChangeSet, "digest">, hash: (s: string) => Digest): Digest {
  const payload = {
    schemaVersion: cs.schemaVersion,
    mode: cs.mode,
    workspaceId: cs.workspaceId,
    baseline: cs.baseline,
    files: cs.files.map((f) => ({
      path: f.path,
      status: f.status,
      oldPath: f.oldPath ?? null,
      contentDigest: f.contentDigest,
      ranges: f.ranges,
      linesAdded: f.linesAdded,
      linesDeleted: f.linesDeleted
    }))
  };
  return hash(canonicalJsonStringify(payload));
}

export async function buildChangeSet(opts: BuildChangeSetOptions): Promise<ChangeSet> {
  const { workspaceRootAbs, runGit, digestFile, workspaceId } = opts;
  const diagnostics: string[] = [];

  const rootRes = await runGit([...GIT_COMMON, "rev-parse", "--show-toplevel"], workspaceRootAbs);
  if (rootRes.code !== 0) {
    throw new CpError("CP_NOT_A_GIT_REPO", `not a git repository: ${workspaceRootAbs}`);
  }
  const repoRoot = rootRes.stdout.trim();

  // baseline commit
  let baselineCommit: string | null = null;
  if (opts.baselineKind === "merge-base") {
    const ref = opts.mergeBaseRef ?? "origin/main";
    const mb = await runGit([...GIT_COMMON, "merge-base", ref, "HEAD"], repoRoot);
    if (mb.code !== 0) {
      diagnostics.push(`merge-base with ${ref} failed (${mb.stderr.trim()}); falling back to HEAD baseline`);
      const head = await runGit([...GIT_COMMON, "rev-parse", "HEAD"], repoRoot);
      baselineCommit = head.code === 0 ? head.stdout.trim() : null;
    } else {
      baselineCommit = mb.stdout.trim();
    }
  } else {
    const head = await runGit([...GIT_COMMON, "rev-parse", "HEAD"], repoRoot);
    if (head.code !== 0) {
      diagnostics.push("repository has no commits (empty HEAD); ChangeSet degraded");
    } else {
      baselineCommit = head.stdout.trim();
    }
  }

  const porcelainRes = await runGit([...GIT_COMMON, "status", "--porcelain=v1", "-z"], repoRoot);
  if (porcelainRes.code !== 0) {
    throw new CpError("CP_GIT_FAILED", `git status failed: ${porcelainRes.stderr.trim()}`);
  }
  const porcelain = parsePorcelain(porcelainRes.stdout);

  // unified diff vs baseline for tracked changes (includes staged + unstaged).
  // HEAD-less repositories cannot diff against a baseline: degraded mode.
  let fileDiffs: FileDiff[] = [];
  if (baselineCommit) {
    const diffRes = await runGit([...GIT_COMMON, "diff", "--no-color", "-U0", baselineCommit, "--"], repoRoot);
    if (diffRes.code !== 0 && diffRes.code !== 1) {
      throw new CpError("CP_GIT_FAILED", `git diff failed: ${diffRes.stderr.trim()}`);
    }
    fileDiffs = parseUnifiedDiff(diffRes.stdout);
  }

  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  for (const fd of fileDiffs) {
    const path = toPosix(fd.newPath ?? fd.oldPath ?? "");
    if (!path || path === "/dev/null") continue;
    const porcelainEntry = porcelain.find((e) => e.path === path || e.oldPath === path);
    const status: FileStatus = statusFromDiff(fd, porcelainEntry);
    const isDeleted = status === "deleted";
    const contentDigest = isDeleted ? null : await digestFile(`${workspaceRootAbs}/${path}`).catch(() => null);
    files.push({
      path,
      status,
      oldPath: status === "renamed" && fd.renameFrom ? toPosix(fd.renameFrom) : undefined,
      contentDigest,
      ranges: fd.ranges,
      coverableExecutableLines: [], // filled by changed-lines analysis
      linesAdded: fd.linesAdded,
      linesDeleted: fd.linesDeleted
    });
    seen.add(path);
  }

  // untracked files: only those matching package include globs (conservative)
  for (const e of porcelain) {
    if (e.x !== "?" || e.y !== "?") continue;
    const p = toPosix(e.path);
    if (seen.has(p)) continue;
    const included = opts.untrackedIncludeGlobs.some((g) => globMatch(g, p));
    if (!included) {
      diagnostics.push(`untracked file not covered by any package include: ${p} (excluded from ChangeSet)`);
      continue;
    }
    const lineCount = await countLines(`${workspaceRootAbs}/${p}`);
    files.push({
      path: p,
      status: "untracked",
      contentDigest: await digestFile(`${workspaceRootAbs}/${p}`).catch(() => null),
      ranges: lineCount > 0 ? [{ startLine: 1, endLine: lineCount, kind: "added" }] : [],
      coverableExecutableLines: [],
      linesAdded: lineCount,
      linesDeleted: 0
    });
    seen.add(p);
  }

  // untracked-but-renamed edge: R in worktree without staging appears as two entries; ignore extra.

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const base = {
    schemaVersion: "1.0" as const,
    mode: baselineCommit ? ("git" as const) : ("degraded" as const),
    workspaceId,
    baseline: { kind: opts.baselineKind, commit: baselineCommit },
    files,
    diagnostics
  };
  return { ...base, digest: digestOfChangeSet(base, opts.hashCanonical) };
}

export function computeChangeSetDigest(cs: Omit<ChangeSet, "digest">, hash: (s: string) => Digest): Digest {
  const payload = {
    schemaVersion: cs.schemaVersion,
    mode: cs.mode,
    workspaceId: cs.workspaceId,
    baseline: cs.baseline,
    files: cs.files.map((f) => ({
      path: f.path,
      status: f.status,
      oldPath: f.oldPath ?? null,
      contentDigest: f.contentDigest,
      ranges: f.ranges,
      linesAdded: f.linesAdded,
      linesDeleted: f.linesDeleted
    }))
  };
  return hash(canonicalJsonStringify(payload));
}

async function countLines(absPath: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  try {
    const text = (await readFile(absPath, "utf8")).replace(/\r\n/g, "\n");
    if (text.length === 0) return 0;
    return text.split("\n").filter((l, idx, arr) => !(l === "" && idx === arr.length - 1)).length;
  } catch {
    return 0;
  }
}

/** Deleted-line risk summary (PROJECT.md 8.7): deletions are recorded, never "covered". */
export function deletedLineRisk(files: ChangedFile[]): Array<{ path: string; ranges: string[] }> {
  return files
    .filter((f) => f.linesDeleted > 0)
    .map((f) => ({
      path: f.path,
      ranges: f.ranges
        .filter((r) => r.kind === "deleted")
        .map((r) => `${r.startLine}-${r.endLine}`)
    }));
}
