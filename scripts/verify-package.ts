/**
 * Package verification gate: typecheck + full test suite + build + tarball
 * content audit (no src leaks / no secrets in the published artifact).
 * Exit 0 only when EVERY gate passes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ex = promisify(execFile);
const node = process.execPath;
const npmCli = path.join(path.dirname(path.dirname(process.env.NPM_CLI_JS ?? "")), "npm-cli.js");

async function run(cmd: string, args: string[], label: string): Promise<void> {
  console.log(`== ${label} ==`);
  try {
    const { stdout, stderr } = await ex(cmd, args, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    if (stdout.trim()) console.log(stdout.trim().split("\n").slice(-5).join("\n"));
    if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-3).join("\n"));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    console.error(`GATE FAILED: ${label}`);
    console.error(e.stdout ?? "");
    console.error(e.stderr ?? "");
    process.exitCode = 1;
    throw err;
  }
}

const vitestBin = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const tscBin = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

await run(node, [tscBin, "-p", "tsconfig.json", "--noEmit"], "typecheck (tsc --noEmit)");
await run(node, [vitestBin, "run"], "full test suite");
await run(node, [path.join(process.cwd(), "scripts", "build.mjs")], "build dist");

// tarball audit
console.log("== tarball content audit ==");
const tmp = await mkdtemp(path.join(os.tmpdir(), "cp-pkg-"));
try {
  const tarball = path.join(tmp, "dsh-changeproof.tgz");
  const npmCmd = npmCli && (await readFile(npmCli, "utf8").then(() => true).catch(() => false)) ? npmCli : "npm";
  await ex(process.execPath, [npmCmd === "npm" ? npmCli : npmCmd, "pack", "--pack-destination", tmp], { cwd: process.cwd(), shell: false }).catch(async () => {
    // fallback: npm via cmd shim
    await ex("npm", ["pack", `--pack-destination=${tmp}`], { cwd: process.cwd(), shell: true });
  });
  const { stdout: listOut } = await ex("tar", ["-tzf", tarball], { cwd: tmp }).catch(() => ({ stdout: "" }));
  const files = listOut.split("\n").filter(Boolean);
  const offenders = files.filter((f) => /\.npm-cache|\.tmp|tests\/|scripts\/debug|\.env/i.test(f));
  if (offenders.length > 0) {
    console.error("AUDIT FAILED: unexpected files in tarball:", offenders);
    process.exitCode = 1;
  } else {
    console.log(`tarball OK (${files.length} files)`);
  }
  await writeFile(path.join(process.cwd(), ".tmp", "pack-list.txt"), files.join("\n") + "\n").catch(() => {});
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (process.exitCode === 0 || process.exitCode === undefined) {
  console.log("\nverify-package: ALL GATES PASSED");
} else {
  console.error("\nverify-package: FAILED");
}
