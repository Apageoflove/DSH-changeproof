/**
 * Headless CLI (PROJECT.md 9.4): the three tools work without any Web
 * Client. Prints canonical JSON and maps verdict statuses to exit codes
 * without hijacking the DSH process exit code.
 *
 * Usage:
 *   node src/host/cli.ts plan    --workspace <abs>
 *   node src/host/cli.ts verify  --workspace <abs> [--yes]
 *   node src/host/cli.ts status  --workspace <abs>
 */
import { isToolResult, EXIT_POLICY } from "../shared/result.ts";
import { canonicalJsonStringify } from "../shared/schema.ts";
import { isVerdictStatus } from "../shared/status.ts";
import { createChangeproofHost } from "./index.ts";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const workspace = argValue("workspace");
  if (!command || !workspace || !["plan", "verify", "status"].includes(command)) {
    process.stderr.write("usage: cli.ts <plan|verify|status> --workspace <abs-path> [--yes]\n");
    return 64;
  }
  const approveAll = process.argv.includes("--yes");

  const cp = await createChangeproofHost();
  await cp.activate();
  try {
    if (command === "plan") {
      const result = await cp.tools.invoke("changeproof_plan", { workspace });
      process.stdout.write(canonicalJsonStringify(result) + "\n");
      return result.ok ? 0 : 1;
    }
    if (command === "verify") {
      if (!approveAll) {
        const plan = await cp.tools.invoke("changeproof_plan", { workspace });
        if (!plan.ok || !plan.data) {
          process.stdout.write(canonicalJsonStringify(plan) + "\n");
          return 1;
        }
        const preview = (plan.data as { preview: Array<{ stepId: string; argv: string[]; cwd: string; timeoutMs: number }> }).preview;
        process.stderr.write("== commands to execute ==\n");
        for (const p of preview) {
          process.stderr.write(`  [${p.stepId}] cwd=${p.cwd || "."} timeout=${p.timeoutMs}ms\n    ${p.argv.map((a) => JSON.stringify(a)).join(" ")}\n`);
        }
        process.stderr.write("Project tests may have REAL side effects. Re-run with --yes to approve.\n");
        process.stdout.write(canonicalJsonStringify(plan) + "\n");
        return 65; // EX_DATAERR: approval required
      }
      const result = await cp.tools.invoke("changeproof_verify", { workspace, approvalIntent: "approve" });
      process.stdout.write(canonicalJsonStringify(result) + "\n");
      const status = result.ok && result.data && isVerdictStatus((result.data as { verdict?: { status?: string } }).verdict?.status)
        ? ((result.data as { verdict: { status: keyof typeof EXIT_POLICY } }).verdict.status)
        : null;
      return status ? EXIT_POLICY[status] : 1;
    }
    const result = await cp.tools.invoke("changeproof_status", { workspace });
    process.stdout.write(canonicalJsonStringify(result) + "\n");
    return result.ok ? 0 : 1;
  } finally {
    cp.dispose();
  }
}

// Only run when invoked directly (source via type-stripping or built bundle),
// never when imported by the DSH bundle loader.
const invokedAs = (process.argv[1] ?? "").replace(/\\/g, "/");
const invokedDirectly = /\/cli\.(ts|mjs)$/.test(invokedAs) && !process.env["DSH_CHANGEPROOF_IMPORTED"];
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 70;
    });
}

export { main as runHeadless, isToolResult };
