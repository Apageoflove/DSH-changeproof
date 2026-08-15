# DSH-changeproof（变更证明 ChangeProof）

一个装进 DeepSeek Harness（DSH）的小插件，负责一件事：**代码改完之后，确认改动的那些行真的被测试跑到过。**

## 它解决什么问题

"跑测试，测试过了就算改对"——这个流程有个大漏洞：

- 你改了 A 文件，跑的是 B 文件的测试，全绿，但你改的东西压根没被测到；
- 测试跑了，但只执行到你改的 10 行里的 3 行，剩下 7 行没测到，照样报"通过"；
- 验证完之后代码又被改了，之前那句"验证通过"还挂在那，像没过期一样。

ChangeProof 把这三件事堵上：

1. **算出哪些测试跟你的改动有关**（顺着代码引用关系找，不是全量瞎跑，也不是拍脑袋猜）；
2. **跑完测试后对行号**：你改的每一行，有没有真的被执行到。改了 10 行只测到 3 行 → 不给通过，明确告诉你哪 7 行没测到；
3. **结论有保质期**：证据绑定当时的代码状态（指纹），代码一变，旧结论自动作废。

换句话说：**"测试通过了"不等于"改动被验证了"。** 这个插件就是把这个区别给你抓出来。

## 装完之后是什么体验

装好后 DSH 里会多三个工具，模型在对话中会自动调用：

| 工具 | 干什么 | 什么时候被调用 |
|---|---|---|
| `changeproof_plan` | 出检查清单：这次改动涉及哪些测试，怎么验 | 问"这个改动影响哪些测试"时 |
| `changeproof_verify` | 真跑测试，对行号，给结论 | 改完代码后（有自动触发规则，不用你记） |
| `changeproof_status` | 查旧结论还作不作数 | 问"上次验证还有效吗"时 |

插件还带一条**工作流规则**：模型每次修改或新增代码后，默认自己调 `changeproof_verify` 验证，不用你每次提醒。

结论一共六种：`VERIFIED`（通过）、`PARTIAL`（部分，有行没测到）、`FAILED`（测试挂了）、`STALE`（代码变了，旧结论作废）、`UNVERIFIED`（没有可信证据，不评）、`NOT_APPLICABLE`（这次改动不涉及可测代码）。

其中有一条底线：**测试过了但没有覆盖证据，或者证据对不上当前代码，一律不给 VERIFIED。** 不会出现"假装通过"。

## 部署到 DSH（完整步骤）

以下在 Windows 实测通过（macOS/Linux 命令相同，路径换成你自己的）。

### 前提

- Node.js 24 或更高（DSH 要求 `^22.19 || >=24`）
- pnpm 11.7（`npm install -g pnpm@11.7.0`，或用 corepack）
- Git

### 第一步：拿到 DSH 源码

```bash
# GitHub 直连不通的话用 Gitee 镜像（内容一样）
git clone --depth 1 https://gitee.com/mirrors/deepseek-harness.git DSH
cd DSH
```

### 第二步：装依赖、构建 DSH

```bash
pnpm install
pnpm run build:lib      # 构建核心库
pnpm run build:web      # 构建 web 前端（只用 headless 可跳过）
```

### 第三步：构建插件

```bash
cd E:\agent\dsh-changeproof   # 换成你的插件目录
npm install
npm run build                 # 产物在 dist/，含 DSH 插件入口
```

### 第四步：装进 DSH

```bash
cd <DSH 目录>
pnpm dsh plugin --profile web add E:\agent\dsh-changeproof
```

- 想同时在命令行用（headless），再加一个 profile：
  ```bash
  pnpm dsh plugin --profile headless add E:\agent\dsh-changeproof
  ```
- `web` 是图形界面 profile，`headless` 是纯命令行 profile，两者独立，装哪个看你要用哪个。

### 第五步：确认装上了

```bash
pnpm dsh --profile web --dump-config | grep changeproof
```

能看到 `# == dsh-changeproof` 这一层，就说明装上了。

### 第六步：用起来

```bash
# 图形界面
pnpm dsh web          # 打开 http://127.0.0.1:3080，在设置里填 API Key

# 或命令行（需要 DEEPSEEK_API_KEY 环境变量）
export DEEPSEEK_API_KEY=sk-xxxxxxxx
pnpm dsh --profile headless "把 src/calc.ts 的折扣从 8 折改成 75 折"
```

对话里说"帮我改个 xx 并验证"，模型改完会自动调 `changeproof_verify` 给你结论。

### 卸载

```bash
pnpm dsh plugin --profile web remove dsh-changeproof
```

卸载后插件、依赖、配置层全部清干净，不留残留。

### 分发给别人

- 对方把插件目录拷过去，按第四步 `add` 本地路径即可；
- 或者等发布到 npm 后，`pnpm dsh plugin add dsh-changeproof` 一条命令装（目前未发布）。

## 不装 DSH 也能用（命令行单独跑）

插件核心不依赖 DSH，单独用命令行也行：

```bash
cd <插件目录>
npm install && npm run build

# 在你自己的项目里验证（项目根需要有 .changeproof.yml，见下）
node dist/host/cli.mjs plan   --workspace E:\my-project   # 只看计划，不执行
node dist/host/cli.mjs verify --workspace E:\my-project --yes   # 真跑测试
node dist/host/cli.mjs status --workspace E:\my-project   # 结论是否过期
```

`verify` 不加 `--yes` 只会打印将要执行的命令清单，确认后加 `--yes` 才真跑。

## 被验证的项目要配什么

在你要验证的项目根目录放一个 `.changeproof.yml`，告诉插件：你的代码在哪、测试用什么命令跑、覆盖率产物输出到哪：

```yaml
schemaVersion: 1
packages:
  - id: web
    root: packages/web
    languages: [typescript]
    include: [packages/web/src/**/*.ts]       # 源码范围
    test:
      adapter: vitest-istanbul                # vitest / jest / pytest 都支持
      argv: [pnpm, vitest, run, --coverage]   # 你项目自己的测试命令
      cwd: packages/web
      timeoutMs: 120000
      coverageFile: packages/web/coverage/coverage-final.json
thresholds: { changedLines: 1.0, minimumImpactConfidence: MEDIUM }
exclude: ["**/generated/**", "**/*.d.ts"]     # 排除不用验证的目录
```

完整字段说明见 [docs/configuration.md](docs/configuration.md)。

## 测试

本仓库自带 163 项测试（单元、集成、端到端、安全等）和 31 个基准用例，全部可离线跑：

```bash
npm test            # 全量测试
npm run benchmark   # 31 个基准场景：12 个"测试全绿但实际没验到"的假绿 case 全部被识破
npm run verify-package   # 类型检查 + 测试 + 构建 + 打包内容审计
```

## 目录结构

```
src/shared/      核心数据模型和状态机（不依赖 DSH，可单独复用）
src/host/        三个工具、分析引擎、执行器、证据存储
src/host/adapters/dsh/   DSH 绑定层（装进 DSH 的入口都在这里）
src/client/      界面组件（预留，当前版本未启用）
tests/           测试
fixtures/        测试用的真实产物样本
docs/            文档
```

## 已知限制

- Web 界面里的插件面板（UI 组件）还没接，当前版本只有模型工具形态；
- 静态 import graph 识别不了路径别名之类的特殊导入（遇到会明确标注"置信度降级"，不会假装精确）；
- 删除的代码行无法用覆盖率证明，插件只记录风险，需要你自己补静态检查或 mutation 验证。

## 仓库

https://github.com/Apageoflove/DSH-changeproof

## License

MIT
