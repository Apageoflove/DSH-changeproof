# 兼容性

## 真实 DSH 接入状态（已实测，2026-08-15）

**上游：** `github.com/deepseek-ai/deepseek-harness` commit `47f9438`（0.1.0-rc.5），镜像克隆至 `E:\agent\DSH`（Gitee 镜像，上游零 diff）。

**插件嵌入结果（全部真实运行）：**

| 验证项 | 结果 |
|---|---|
| `dsh plugin --profile web/headless add <插件目录>` | ✅ bundles 列表追加 `dsh-changeproof` |
| `dsh --profile <name> --dump-config` | ✅ 出现 `# == dsh-changeproof` 层 |
| headless 端到端（真实模型 + 真实工具调用） | ✅ `changeproof_plan` → PLAN_OK；`changeproof_verify`（approvalIntent=approve，真实 vitest 子进程）→ **VERIFIED**；`changeproof_status` → fresh → 篡改后 **stale** |
| web 启动 | ✅ `dsh web` 正常起服（http://127.0.0.1:3080），插件在 web profile 同样注册 3 工具 |
| 卸载 | ✅ `remove` 后 bundles/依赖/dump-config 全部无残留 |

**接入适配要点（全部收敛在 `src/host/adapters/dsh/`）：**
1. 插件形态：`export const name / inject / apply(ctx)`，工具经公开 `ctx.tools.register()`（`defineTool` 形状）注册。
2. patch 格式：**顶层数组**（`- insert: [{id, name}]`），不是 mapping。
3. `dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 暂未启用（Web UI 槽位后续版本接入）。
4. **rc.5 时序特性**：插件 apply 时 `inject` 的服务可能尚未挂载完成，`ctx.tools` 会懒建"孤儿空实例"——必须 `await ctx.inject(["tools"], ...)` 等真实例就绪后再注册（见 cordis-plugin.ts 注释与 scripts/dsh-tool-visibility-probe.ts）。
5. 工具输出须为 lossless JSON：返回值经 canonicalize 清洗（undefined 字段剔除、非有限数归一）。

## 运行时探测（scripts/seam-probe.ts）

插件启动时探测 DeepSeek Harness / Cordis 运行时：

| 能力 | 真实 DSH | standalone（当前机器） |
|---|---|---|
| tools 注册/调用 | 适配 `ctx.tools` | 进程内注册表（相同契约） |
| subprocess 宿主管道 | 适配审批/sandbox 管道 | `node:child_process`（argv-only、超时、取消、进程树终止） |
| fs | 适配 `ctx.fs` | `node:fs/promises`（有界读取 + 工作区牢笼） |
| events（tools/post-execute 公共事件） | ✅ | ❌（报告里显式标注） |
| Web UI slots | ✅（Web Profile） | ❌（headless 完整可用） |

当前环境探测结果：**standalone** —— DeepSeek Harness 未安装。三个工具、canonical JSON、状态机、证据持久化**全部可用**（本仓库 163 项测试即在 standalone 模式下运行）。真实 DSH 的绑定只存在于 `src/host/adapters/dsh/`，其余代码零 DSH 依赖。

## 上游策略（PROJECT.md 15.2）

- 本插件**从不** clone / fork / 修改上游 DSH 仓库；无 patch 文件。
- 如需验证上游工作区未被污染：`DSH_UPSTREAM_CHECKOUT=<path> node scripts/check-upstream-clean.ts`（未配置时显式 SKIP，不伪造通过）。
- 预期 DSH 破坏性变更 → 只改 `src/host/adapters/dsh/` 单个提交 + capability 报告对比 + 契约测试。

## 已实测的环境

| 项 | 值 |
|---|---|
| Node | v24.16.0（≥20.11 约束） |
| Git | 2.53.0.windows.1 |
| JS runner | vitest 3.x + @vitest/coverage-v8（真实运行，真实 Istanbul `coverage-final.json`） |
| Python runner | pytest 8.x + coverage 7.15.4（项目内 venv `.tmp/pyenv`，真实运行） |

## schema 版本

- 工具结果：`1.0`（未知版本在 Client 端 fail loud：`CP_SCHEMA_VERSION_UNSUPPORTED`）
- coverage.py JSON：format `3`、coverage 6.x/7.x（其他版本拒绝并给出明确原因码）
- Istanbul JSON：`coverage-final.json` 结构契约由 `fixtures/js-vitest/coverage-final.json` 钉死

## 已知限制（诚实清单）

1. JS 静态 import graph 不解析 path alias / monorepo workspace 协议导入（标记 incomplete → MEDIUM 上限，绝不冒充 HIGH）。
2. 命名约定层永远只产生 LOW 候选——它是候选来源，不是穷尽证明。
3. mutation-smoke 层在本 MVP 中**未实现**（规划中显式排除，不会假装有这个能力）。
4. Web in-app E2E 依赖真实 DSH Web profile；当前仅有公共 ClientShell 契约的静态投影冒烟（该 gate 保持 UNVERIFIED 直到 profile 存在）。
