/**
 * Test helper: real temporary Git workspaces under <project>/.tmp/
 * (inside the project boundary; cleaned per-suite).
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const TMP_ROOT = path.join(projectRoot, ".tmp");

export async function makeTmpDir(prefix: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  return mkdtemp(path.join(TMP_ROOT, prefix + "-"));
}

export async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "global", GIT_AUTHOR_NAME: "cp-test", GIT_AUTHOR_EMAIL: "cp@test", GIT_COMMITTER_NAME: "cp-test", GIT_COMMITTER_EMAIL: "cp@test" } as never });
}

export async function initRepo(dir: string, files: Record<string, string>, commitMessage = "init"): Promise<void> {
  await git(dir, "init", "-q");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=cp-test", "-c", "user.email=cp@test", "commit", "-q", "-m", commitMessage);
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { projectRoot };

/** Path to the plugin's own vitest entry (used by JS fixtures as a real runner). */
export function pluginVitestPath(): string {
  return path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
}

/** Node executable currently running tests. */
export const nodeExe = process.execPath;
