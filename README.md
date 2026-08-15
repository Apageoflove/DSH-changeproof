# dsh-changeproof（ChangeProof）

> DeepSeek Harness（DSH）插件：**变更相关性 + 证据新鲜度**的质量护栏。
> "这个改动需要跑哪些测试？" —— 且 **exit 0 不再等于 PASS**。

## 为什么

传统 Agent 交付流程的两个系统性盲区：

1. **"跑全量太慢 → 只跑一部分"** 是猜的：没有受影响测试集合与量化证据。
2. **"测试通过了" ≠ "本次改动被验证"**：跑的是无关测试、产物缺失、或代码在验证后又变了，都能伪装成绿色。

ChangeProof 用四级 impact 解析（显式映射 → 历史 coverage map → 静态 import graph → 命名约定）产出分层最小计划，执行后解析**改动行级**覆盖率，把一切结论绑定到 workspace fingerprint 上的证据记录。

## 六态结论（固定优先级）

`STALE → FAILED → UNVERIFIED(归因) → PARTIAL → VERIFIED`；`NOT_APPLICABLE` 仅由带原因码的确定性规则产生。

硬性红线（测试钉死）：
- exit 0 但缺 coverage 产物 / 解析错误 / LOW 置信度映射 → **绝不 VERIFIED**
- 非 Git 工作区 → **绝不 VERIFIED**
- 运行期间工作区变化 / 证据绑定旧 fingerprint → **一律 STALE**，即使全绿
- 删除行永不计入覆盖率分母（单独的删除风险记录）

## 快速开始

### 作为 DSH 插件（已与真实 DSH 集成验证）

**已实测**：deepseek-harness `47f9438`（0.1.0-rc.5）+ 本插件在 web/headless 两个 profile 下真实加载，headless 端到端（真实模型调用）：plan → PLAN_OK、verify（真实 vitest 子进程）→ **VERIFIED**、status → fresh → 篡改后 **stale**；web 正常起服；卸载零残留。详见 docs/compatibility.md。

```sh
# 在 DSH 源码根目录（先 pnpm install && pnpm run build）
pnpm dsh plugin --profile web      add E:/agent/dsh-changeproof   # 或 headless
pnpm dsh --profile web --dump-config        # 应出现 "# == dsh-changeproof" 层
pnpm dsh web                                # http://127.0.0.1:3080
pnpm dsh plugin --profile web remove dsh-changeproof
```

接入适配全部收敛在 `src/host/adapters/dsh/`（插件形态 / patch 顶层数组格式 / inject 等待 / lossless JSON 输出）。Web UI 槽位（Client）为后续版本范围。

### Headless（无 DSH 也完整可用）

```bash
npm install && npm run build

node dist/host/cli.mjs plan   --workspace /abs/path/to/repo   # 只分析，不执行
node dist/host/cli.mjs verify --workspace /abs/path/to/repo --yes
node dist/host/cli.mjs status --workspace /abs/path/to/repo
```

`verify` 不带 `--yes` 只打印**将执行的完整命令预览**（argv/cwd/timeout/期望产物 + 真实副作用警告）并以 65 退出。退出码：VERIFIED/NOT_APPLICABLE=0，FAILED=1，STALE=2，PARTIAL=3，UNVERIFIED=4。

### 最小配置（被验证仓库根的 `.changeproof.yml`）

```yaml
schemaVersion: 1
packages:
  - id: web
    root: packages/web
    languages: [typescript]
    include: [packages/web/src/**/*.ts]
    test:
      adapter: vitest-istanbul
      argv: [pnpm, vitest, run, --coverage]
      cwd: packages/web
      timeoutMs: 120000
      coverageFile: packages/web/coverage/coverage-final.json
thresholds: { changedLines: 1.0, minimumImpactConfidence: MEDIUM }
exclude: ["**/generated/**", "**/*.d.ts"]
```

## 测试（本仓库自身）

```bash
npm test              # 163 项：单元 / 属性 / 契约 / 集成 / E2E / 视觉 / 无障碍 / 安全
npm run benchmark     # 31 个基准 case（真实 git 工作区 + 真实子进程）
npm run verify-package  # typecheck + 全量测试 + 构建 + tarball 审计
npm run seam-probe      # DSH capability 探测报告
```

实测（Windows / Node 24 / vitest 3 / pytest 8 + coverage 7.15.4）：

- **测试 163/163 通过**（含真实 vitest 全链路、真实 pytest+coverage.py 全链路、headless CLI E2E）
- **基准 31/31 通过**：12 个"exit 0 假绿"case 全部被识破，**0 静默失败**，中位单 case 墙钟 ~0.6s
- 全部数字为实测输出，见 `.tmp/benchmark-report.json`

## 仓库布局

```
src/shared/    跨端内核：models / 状态机语义 / 错误码 / 规范 JSON（零 Node/DSH 依赖）
src/host/      tools(plan/verify/status) · analysis(impact/coverage/fingerprint/verdict)
               · execution(planner/executor/命令策略/进程树/输出上限) · persistence · adapters(git/istanbul/coverage.py/…)
src/host/adapters/dsh/   唯一 DSH 绑定层（capability 探测 + 端口；无 DSH 时 standalone 回退）
src/client/    投影(reducer 只折叠不推断) + Proofboard 组件 + CSS Modules
tests/         unit / property / contract / integration / e2e / visual / accessibility / security
fixtures/      真实产物契约 + fake-runner（确定性离线基准）
docs/          architecture / configuration / compatibility / security / adapters / troubleshooting
```

## 文档

- [架构](docs/architecture.md) · [配置](docs/configuration.md) · [适配器](docs/adapters.md)
- [兼容性与已知限制](docs/compatibility.md) · [安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## License

MIT
