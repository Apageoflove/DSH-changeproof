/**
 * Fixture benchmark runner: executes all cases and writes a MEASURED report
 * to .tmp/benchmark-report.json. Exit code 0 only when every case matches
 * its expected verdict AND zero silent false-VERIFIED failures occurred.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "./benchmark-cases.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
// optional filter: a case id or group name (used for focused debugging)
const filter = process.argv[2];

console.log("running ChangeProof fixture benchmark (real git workspaces + real subprocesses)...");
const { results, metrics } = await runBenchmark(filter);

for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"} [${r.group}] ${r.id}: expected=${r.expected} actual=${r.actual} (${r.durationMs}ms, baselineExit0=${r.baselineExitZero})`);
  if (!r.pass) for (const reason of r.reasons) console.log(`    reason: ${reason}`);
}
console.log("\n=== metrics (measured, not estimated) ===");
console.log(JSON.stringify(metrics, null, 2));

await mkdir(path.join(projectRoot, ".tmp"), { recursive: true });
await writeFile(path.join(projectRoot, ".tmp", "benchmark-report.json"), JSON.stringify({ results, metrics }, null, 2), "utf8");
console.log("\nreport written to .tmp/benchmark-report.json");

const allPass = results.every((r) => r.pass);
const noSilentFailure = metrics.silentFailureCount === 0;
process.exitCode = allPass && noSilentFailure ? 0 : 1;
