/**
 * Upstream-clean check (PROJECT.md 15.2): asserts that a checked-out
 * DeepSeek Harness workspace (if one is configured) is untouched by us.
 * We never clone or modify upstream in normal operation; when no checkout is
 * configured, this gate reports an explicit SKIP (never a fake pass).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const ex = promisify(execFile);
const upstream = process.env["DSH_UPSTREAM_CHECKOUT"];

if (!upstream) {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "SKIPPED", reason: "DSH_UPSTREAM_CHECKOUT not configured; nothing was cloned or modified" }, null, 2));
  process.exit(0);
}

try {
  await access(path.join(upstream, ".git"));
} catch {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "ERROR", reason: `${upstream} is not a git checkout` }, null, 2));
  process.exit(1);
}

const { stdout } = await ex("git", ["status", "--porcelain"], { cwd: upstream });
const dirty = stdout.split("\n").filter((l) => l.trim().length > 0);
const report = {
  schemaVersion: "1.0",
  status: dirty.length === 0 ? "CLEAN" : "DIRTY",
  upstream,
  dirtyFiles: dirty
};
console.log(JSON.stringify(report, null, 2));
process.exit(dirty.length === 0 ? 0 : 1);
