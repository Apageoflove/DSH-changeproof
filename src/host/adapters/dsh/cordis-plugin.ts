/**
 * DSH 插件入口（cordis）。
 * 经 cordis.patch.yml 的 insert 行加载，按官方插件契约导出 name/inject/apply，
 * 工具通过公开的 ctx.tools.register() 注册。
 * 不 import @deepseek-ai/dsh-tools：defineTool 只是类型包装，register 只校验
 * 编译后的 schema，省掉一个 peer 依赖。
 */
import { createChangeproofHost, type ChangeproofHost } from "../../index.ts";
import type { HostContext } from "./compatibility-facade.ts";
import { planTool } from "../../tools/plan.ts";
import { verifyTool } from "../../tools/verify.ts";
import { statusTool } from "../../tools/status.ts";
import { canonicalJsonStringify, canonicalize } from "../../../shared/schema.ts";

/** cordis Context 上我们实际用到的部分。 */
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
  /** 向模型的每轮提示注入规则文本。 */
  readonly systemPrompt: {
    section(options: { name: string; order: number; text: string }): void;
  };
  /** 插件卸载时执行清理。 */
  effect(callback: () => void): void;
  /** 等待指定服务可用后再执行。 */
  inject(services: string[], callback: (ctx: DshPluginContext) => void): Promise<void> | void;
  readonly logger?: { info(msg: string): void; warn(msg: string): void };
}

export const name = "dsh-changeproof";
export const inject = ["tools", "systemPrompt"];

let hostPromise: Promise<ChangeproofHost> | null = null;

async function getHost(): Promise<ChangeproofHost> {
  hostPromise ??= createChangeproofHost();
  return hostPromise;
}

function jsonRender(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  // 模型输出要求确定性的规范 JSON。
  return [{ type: "text", text: canonicalJsonStringify(value) }];
}

function requireWorkspace(args: Record<string, unknown>): string {
  const ws = args["workspace"];
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error("input.workspace is required (absolute path of the workspace root)");
  }
  return ws;
}

/** workspace 参数的 JSON Schema。 */
const WORKSPACE_PROPERTY = {
  type: "string",
  description: "要分析的工作区（git 仓库）根目录的绝对路径。"
} as const;

const BASELINE_PROPERTY = {
  type: "string",
  enum: ["head", "merge-base"],
  description: "对比的 git 基线。默认 head。"
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
          description: "明确批准：将真实执行项目测试（可能有副作用）。"
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
  // rc.5 的一个坑：插件 fiber 在 tools 服务挂载完之前 inject 的话，
  // ctx.tools 会拿到一个空的临时 registry。等真实例就绪再注册。
  await ctx.inject(["tools"], () => {});
  const registry = ctx.tools as DshToolRuntime;

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
          // DSH 要求输出是 lossless JSON：去掉 undefined 字段、归一非有限数。
          return canonicalize(result);
        }
      })
    );
  }
  // 启动日志，用于确认插件加载成功。
  console.error(`[changeproof] apply() registered ${TOOL_DEFS.length} tools: ${TOOL_DEFS.map((d) => d.toolId).join(", ")}`);
}

export { TOOL_DEFS as CHANGEPROOF_TOOL_DEFS };
