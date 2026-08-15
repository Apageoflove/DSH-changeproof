# DSH-changeproof（变更证明 ChangeProof）

DeepSeek Harness（DSH）插件：代码改动后，确认改动的行真的被测试覆盖到。

## 解决的问题

"测试通过"不等于"改动被验证"：

- 改的是 A 文件，测试跑的是 B 文件，全绿但改动没被测到；
- 测试跑了，但只执行到改动行的一部分，剩余行没测到，照样报通过；
- 验证完成后代码又被修改，旧结论仍然有效，无人察觉。

插件做三件事：

1. **关联测试**：根据代码引用关系，找出与本次改动相关的测试（不是全量跑，也不是猜）；
2. **行级核对**：执行测试后逐行核对，改动行未被执行到则不予通过，并明确指出未覆盖的行；
3. **结论过期**：证据绑定代码指纹，代码一变，旧结论自动失效。

结论状态：`VERIFIED`（通过）、`PARTIAL`（部分覆盖）、`FAILED`（测试失败）、`STALE`（结论过期）、`UNVERIFIED`（无有效证据）、`NOT_APPLICABLE`（无可验证内容）。

底线：**没有覆盖证据，或证据与当前代码不一致，一律不给 VERIFIED。**

## 部署到 DSH

以下步骤在 Windows 实测通过（macOS / Linux 命令相同）。

### 前提

- Node.js ≥ 24（DSH 要求 `^22.19 || >=24`）
- pnpm 11.7（`npm install -g pnpm@11.7.0`）
- Git

### 1. 获取 DSH 源码

```bash
git clone --depth 1 https://gitee.com/mirrors/deepseek-harness.git DSH
# GitHub 直连：git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git DSH
cd DSH
```

### 2. 构建 DSH

```bash
pnpm install
pnpm run build:lib
pnpm run build:web   # 仅使用 headless 可跳过
```

### 3. 构建插件

```bash
cd <插件目录>        # 如 E:\agent\dsh-changeproof
npm install
npm run build        # 产物在 dist/
```

### 4. 安装到 profile

```bash
cd <DSH 目录>
pnpm dsh plugin --profile web add <插件目录>
# 需要命令行模式再加：pnpm dsh plugin --profile headless add <插件目录>
```

### 5. 验证安装

```bash
pnpm dsh --profile web --dump-config | grep changeproof
# 输出包含 "# == dsh-changeproof" 即安装成功
```

### 6. 使用

```bash
# 图形界面
pnpm dsh web    # 访问 http://127.0.0.1:3080，设置中填入 API Key

# 命令行（需 DEEPSEEK_API_KEY 环境变量）
export DEEPSEEK_API_KEY=sk-xxxxxxxx
pnpm dsh --profile headless "修改 src/calc.ts 的折扣为 75 折并验证"
```

模型修改代码后会自动调用 `changeproof_verify` 验证（插件自带工作流规则，无需手动触发）。

### 卸载

```bash
pnpm dsh plugin --profile web remove dsh-changeproof
```

### 分发

- 对方获得插件目录后按步骤 4 `add` 本地路径；
- 发布到 npm 后（暂未发布）：`pnpm dsh plugin add dsh-changeproof`。

## 独立使用（不装 DSH）

```bash
cd <插件目录>
npm install && npm run build

node dist/host/cli.mjs plan   --workspace <项目路径>   # 仅分析
node dist/host/cli.mjs verify --workspace <项目路径> --yes   # 执行测试
node dist/host/cli.mjs status --workspace <项目路径>   # 结论是否过期
```

`verify` 不带 `--yes` 仅打印将执行的命令，确认后加 `--yes` 才执行。

## 被验证项目的配置

项目根目录放置 `.changeproof.yml`：

```yaml
schemaVersion: 1
packages:
  - id: web
    root: packages/web
    languages: [typescript]
    include: [packages/web/src/**/*.ts]
    test:
      adapter: vitest-istanbul    # 支持 vitest / jest / pytest
      argv: [pnpm, vitest, run, --coverage]
      cwd: packages/web
      timeoutMs: 120000
      coverageFile: packages/web/coverage/coverage-final.json
thresholds: { changedLines: 1.0, minimumImpactConfidence: MEDIUM }
exclude: ["**/generated/**", "**/*.d.ts"]
```

字段说明见 [docs/configuration.md](docs/configuration.md)。

## 测试

```bash
npm test            # 163 项测试
npm run benchmark   # 31 个基准用例（12 个"假绿"场景全部被识破）
npm run verify-package
```

## 目录结构

```
src/shared/      核心模型与状态机（不依赖 DSH）
src/host/        工具、分析引擎、执行器、证据存储
src/host/adapters/dsh/   DSH 绑定层
src/client/      界面组件（预留，未启用）
tests/           测试
fixtures/        测试用真实产物样本
docs/            文档
```

## 已知限制

- 界面组件（Client）未接入，当前为模型工具形态；
- 静态 import graph 无法解析路径别名等特殊导入，遇到时明确标注置信度降级；
- 删除的代码行无法用覆盖率证明，仅记录风险。

## 仓库

https://github.com/Apageoflove/DSH-changeproof

## License

MIT
