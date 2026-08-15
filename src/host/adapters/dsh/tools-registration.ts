/**
 * Tool registration seam. Under real DSH this adapts `ctx.tools`; standalone
 * mode registers into an in-process registry used by the headless CLI and
 * tests. Registration/unregistration is effect-bound (clean unload).
 */
import type { ChangeProofToolResult } from "../../../shared/result.ts";

export type ToolId = "changeproof_plan" | "changeproof_verify" | "changeproof_status";

export interface ToolDefinition {
  id: ToolId;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ChangeProofToolResult<unknown>>;
}

export interface ToolsPort {
  register(def: ToolDefinition): () => void;
  list(): ToolDefinition[];
  invoke(id: ToolId, input: Record<string, unknown>): Promise<ChangeProofToolResult<unknown>>;
}

export class StandaloneToolsPort implements ToolsPort {
  private tools = new Map<ToolId, ToolDefinition>();

  register(def: ToolDefinition): () => void {
    this.tools.set(def.id, def);
    return () => this.tools.delete(def.id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async invoke(id: ToolId, input: Record<string, unknown>): Promise<ChangeProofToolResult<unknown>> {
    const def = this.tools.get(id);
    if (!def) {
      throw new Error(`tool not registered: ${id}`);
    }
    return def.handler(input ?? {});
  }
}

export const TOOL_DESCRIPTIONS: Record<ToolId, string> = {
  changeproof_plan:
    "Analyze the current ChangeSet, test impact and layered verification plan. Does NOT execute project code.",
  changeproof_verify:
    "Re-confirm the workspace fingerprint, execute the layered plan (cheap checks → targeted tests → changed-line coverage), parse artifacts and persist evidence. Executes project tests: real side effects possible; requires approval intent.",
  changeproof_status:
    "Recompute the current workspace fingerprint and report whether the latest evidence is fresh or stale."
};

export const TOOL_INPUT_SCHEMAS: Record<ToolId, Record<string, unknown>> = {
  changeproof_plan: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "absolute path of the workspace root" },
      baseline: { type: "string", enum: ["head", "merge-base"] }
    },
    required: ["workspace"]
  },
  changeproof_verify: {
    type: "object",
    properties: {
      workspace: { type: "string" },
      baseline: { type: "string", enum: ["head", "merge-base"] },
      approvalIntent: { type: "string", enum: ["preview", "approve"] }
    },
    required: ["workspace", "approvalIntent"]
  },
  changeproof_status: {
    type: "object",
    properties: { workspace: { type: "string" } },
    required: ["workspace"]
  }
};
