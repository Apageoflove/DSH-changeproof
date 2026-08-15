/**
 * ChangeProof Host service entry (loaded via cordis.patch.yml).
 * Wires the DSH compatibility facade, registers the three model-facing tools
 * and exposes lifecycle activation/deactivation. Under a real DSH host the
 * returned disposers are bound to Cordis effects; standalone callers use
 * them directly. Unload leaves no watchers, processes or registrations.
 */
import { createHostContext, type HostContext } from "./adapters/dsh/compatibility-facade.ts";
import {
  StandaloneToolsPort,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  type ToolsPort,
  type ToolId
} from "./adapters/dsh/tools-registration.ts";
import { planTool } from "./tools/plan.ts";
import { verifyTool } from "./tools/verify.ts";
import { statusTool } from "./tools/status.ts";

export * from "../shared/index.ts";
export { createHostContext } from "./adapters/dsh/compatibility-facade.ts";
export { planTool } from "./tools/plan.ts";
export { verifyTool } from "./tools/verify.ts";
export { statusTool } from "./tools/status.ts";
export type { PlanData } from "./tools/plan.ts";
export type { VerifyData } from "./tools/verify.ts";
export type { StatusData } from "./tools/status.ts";

export interface ChangeproofHost {
  host: HostContext;
  tools: ToolsPort;
  activate(): Promise<void>;
  dispose(): void;
}

export async function createChangeproofHost(): Promise<ChangeproofHost> {
  const host = await createHostContext();
  const tools = new StandaloneToolsPort();
  const disposers: Array<() => void> = [];

  const registerTool = (id: ToolId, handler: (input: Record<string, unknown>) => Promise<unknown>) => {
    const unregister = tools.register({
      id,
      description: TOOL_DESCRIPTIONS[id],
      inputSchema: TOOL_INPUT_SCHEMAS[id],
      handler: async (input) => handler(input) as never
    });
    disposers.push(unregister);
  };

  const requireWorkspace = (input: Record<string, unknown>): string => {
    const ws = input["workspace"];
    if (typeof ws !== "string" || ws.length === 0) {
      throw new Error("input.workspace is required (absolute workspace root path)");
    }
    return ws;
  };

  const self: ChangeproofHost = {
    host,
    tools,
    async activate() {
      registerTool("changeproof_plan", async (input) =>
        planTool(host, requireWorkspace(input), {
          baselineKind: input["baseline"] === "merge-base" ? "merge-base" : undefined
        })
      );
      registerTool("changeproof_verify", async (input) => {
        if (input["approvalIntent"] !== "approve") {
          throw new Error("changeproof_verify requires approvalIntent=approve (project tests will execute)");
        }
        return verifyTool(host, requireWorkspace(input), {
          baselineKind: input["baseline"] === "merge-base" ? "merge-base" : undefined
        });
      });
      registerTool("changeproof_status", async (input) => statusTool(host, requireWorkspace(input)));
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
    }
  };

  return self;
}
