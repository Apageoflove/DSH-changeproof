/**
 * ChangeProof cordis plugin entry — the REAL DeepSeek Harness binding.
 *
 * This module is loaded by the DSH bundle loader (via cordis.patch.yml
 * `- insert: [{ id: changeproof, name: dsh-changeproof }]`). It follows the
 * official plugin contract (see packages/extensions/tool-cordis):
 *
 *   export const name   — plugin id
 *   export const inject — required cordis services
 *   export function apply(ctx) — registration; cleanup via ctx.effect
 *
 * Tool registration goes through the PUBLIC ctx.tools.register() seam with
 * hand-shaped ToolDefinition objects carrying COMPILED standard JSON Schema
 * (parameters = {type:'object', properties, required}; output.schema must be
 * a plain JSON-Schema node — register() rejects author-side specs like
 * {type:'json'}). We deliberately do NOT import
 * @deepseek-ai/dsh-tools at runtime: defineTool() is a typing/wrapping helper
 * and register() only validates the compiled shape, so avoiding the peer
 * import keeps the plugin installable into any profile without transitive
 * resolution issues.
 */
import { createChangeproofHost, type ChangeproofHost } from "../../index.ts";
import type { HostContext } from "./compatibility-facade.ts";
import { planTool } from "../../tools/plan.ts";
import { verifyTool } from "../../tools/verify.ts";
import { statusTool } from "../../tools/status.ts";
import { canonicalJsonStringify, canonicalize } from "../../../shared/schema.ts";

/** Minimal structural typing of the public cordis Context seam we consume. */
interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: unknown;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  readonly timeoutMs?: number;
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

interface DshToolRuntime {
  register(definition: DshToolDefinition): () => void;
}

export interface DshPluginContext {
  readonly tools: DshToolRuntime;
  /** Public system-prompt seam: injects guidance the model sees in every turn. */
  readonly systemPrompt: {
    section(options: { name: string; order: number; text: string }): void;
  };
  /** Cordis effect cleanup: the returned disposer runs on plugin unload. */
  effect(callback: () => void): void;
  /** Cordis dependency resolution: waits until the named services are available. */
  inject(services: string[], callback: (ctx: DshPluginContext) => void): Promise<void> | void;
  /** Logger provided by the host (optional use). */
  readonly logger?: { info(msg: string): void; warn(msg: string): void };
}

export const name = "dsh-changeproof";
export const inject = ["tools", "systemPrompt"];

/** Lazily-created standalone host context (fs/subprocess ports). */
let hostPromise: Promise<ChangeproofHost> | null = null;

async function getHost(): Promise<ChangeproofHost> {
  hostPromise ??= createChangeproofHost();
  return hostPromise;
}

function jsonRender(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  // Canonical JSON keeps model-facing output deterministic (PROJECT.md 9.1).
  return [{ type: "text", text: canonicalJsonStringify(value) }];
}

function requireWorkspace(args: Record<string, unknown>): string {
  const ws = args["workspace"];
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error("input.workspace is required (absolute path of the workspace root)");
  }
  return ws;
}

/** Shared workspace-parameter schema (compiled JSON Schema property). */
const WORKSPACE_PROPERTY = {
  type: "string",
  description: "Absolute path of the workspace (git repository) root to analyze."
} as const;

const BASELINE_PROPERTY = {
  type: "string",
  enum: ["head", "merge-base"],
  description: "Git baseline to diff against. Default: head."
} as const;

const TOOL_DEFS: Array<{
  toolId: "changeproof_plan" | "changeproof_verify" | "changeproof_status";
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  run: (host: HostContext, args: Record<string, unknown>) => Promise<unknown>;
}> = [
  {
    toolId: "changeproof_plan",
    description:
      "Analyze the current ChangeSet (git), resolve which tests are impacted (4-tier: explicit mappings > coverage history > static import graph > naming conventions) and produce a layered verification plan (cheap checks -> targeted tests -> changed-line coverage). Does NOT execute project code.",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY,
        baseline: BASELINE_PROPERTY
      },
      required: ["workspace"]
    },
    timeoutMs: 120_000,
    run: (host, args) => planTool(host, requireWorkspace(args), args["baseline"] === "merge-base" ? { baselineKind: "merge-base" } : {})
  },
  {
    toolId: "changeproof_verify",
    description:
      "Re-confirm the workspace fingerprint, then execute the layered plan (runs the project's OWN test command via argv; real side effects possible), parse changed-line coverage from the Istanbul/coverage.py artifact and persist evidence. Verdicts: VERIFIED / PARTIAL / FAILED / STALE / UNVERIFIED / NOT_APPLICABLE — a green exit code alone NEVER yields VERIFIED. Requires approvalIntent=approve.",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY,
        approvalIntent: {
          type: "string",
          enum: ["approve"],
          description: "Explicit approval: project tests will execute with real side effects."
        },
        baseline: BASELINE_PROPERTY
      },
      required: ["workspace", "approvalIntent"]
    },
    timeoutMs: 3_600_000,
    run: async (host, args) => {
      if (args["approvalIntent"] !== "approve") {
        throw new Error("changeproof_verify requires approvalIntent=approve (project tests will execute with real side effects)");
      }
      return verifyTool(host, requireWorkspace(args), args["baseline"] === "merge-base" ? { baselineKind: "merge-base" } : {});
    }
  },
  {
    toolId: "changeproof_status",
    description:
      "Recompute the current workspace fingerprint and report whether the latest persisted evidence is fresh or stale (any change to changed sources, related tests, lockfiles, runner configs or the plugin config invalidates evidence).",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY
      },
      required: ["workspace"]
    },
    timeoutMs: 120_000,
    run: (host, args) => statusTool(host, requireWorkspace(args))
  }
];

export async function apply(ctx: DshPluginContext): Promise<void> {
  const disposers: Array<() => void> = [];
  // The host's `tools` service may still be mid-mount when this bundle's
  // fiber resolves its `inject` — the getter then lazily creates a throwaway
  // empty registry and later reads resolve to the real one (verified by
  // scripts/dsh-tool-visibility-probe.ts). Wait for the real service to be
  // provided before registering so the model actually sees these tools.
  await ctx.inject(["tools"], () => {});
  // Use the INJECTED tools service (after inject() it resolves to the host's
  // real registry carrying the base tools — the one dispatch executes through).
  // root.tools may be a different instance; prefer the injected one.
  const registry = ctx.tools as DshToolRuntime;

  // Dual-path registration:
  //  1) ctx.tools.register() — the official public seam. On rc.5 the
  //     underlying ctx.effect(generator) is deferred inside apply() fibers,
  //     so insertion may land late; keep it as the primary path so an
  //     upstream fix works without plugin changes.
  //  2) systemPrompt.tools() — the PUBLIC prompt assembly seam; guarantees
  //     the model SEES the tools even while register() is deferred.
  //  (insertion into the registry's layer table as an extra fallback is NOT
  //   used: dispatch resolves through the same tables register() targets, and
  //   a manual insert can collide with the deferred register.)
  for (const def of TOOL_DEFS) {
    disposers.push(
      registry.register({
        name: def.toolId,
        description: def.description,
        parameters: def.parameters,
        output: { schema: { type: "object" }, render: jsonRender },
        timeoutMs: def.timeoutMs,
        execute: async (args) => {
          const cpHost = await getHost();
          const result = await def.run(cpHost.host, (args ?? {}) as Record<string, unknown>);
          // DSH requires lossless JSON output: drop undefined fields and
          // normalize non-finite numbers before returning.
          return canonicalize(result);
        }
      })
    );
  }
  // boot-time diagnostic (stderr): proves apply() ran and tools landed
  console.error(`[changeproof] apply() registered ${TOOL_DEFS.length} tools: ${TOOL_DEFS.map((d) => d.toolId).join(", ")}`);
}

export { TOOL_DEFS as CHANGEPROOF_TOOL_DEFS };
