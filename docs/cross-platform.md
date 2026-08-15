# 跨平台注意点（Windows / macOS / Linux）

ChangeProof 核心实现已按平台分支处理；以下是每层的行为与后续适配要点。

| 层 | Windows（已实测） | macOS / Linux（待实测，代码已分支） |
|---|---|---|
| 子进程终止 | `taskkill /T /F` 终止整棵树（安全测试验证孙进程无孤儿） | 负进程组 `SIGKILL`（spawn 时 `detached` 已开启） |
| 路径牢笼 | 词法检查 + `realpath`；拒绝盘符/UNC/设备名（CON/COM1）；junction 逃逸拒绝（已测） | symlink 逃逸同样经 `realpath` 二次校验（同一代码路径） |
| 换行归一 | 内容 digest 前 CRLF→LF（已测，跨平台一致） | 原生 LF，同一归一函数 |
| Git | `core.quotepath=false` + `-U0` diff（已测） | 相同 argv，无平台差异 |
| coverage.py JSON 键 | 反斜杠路径键（真实 7.15.4 产物已测） | 正斜杠键（`normalizeArtifactPath` 已处理两种） |
| fixture 测试 | vitest + pytest（项目内 venv）全链路已测 | 需在对应平台重跑集成/E2E 套件 |

## 发布前需在 mac/Linux 复验的项

1. `tests/integration/*`（真实 vitest / pytest 子进程）与 `tests/e2e/*`（headless CLI）
2. `scripts/run-fixture-benchmark.ts`（31 case，进程树终止依赖平台分支）
3. DSH 嵌入 e2e：`dsh --profile headless` 三工具真实调用
4. `tests/security/subprocess.security.test.ts` 的孤儿进程断言（Windows 用 PowerShell 探测，POSIX 用 `kill -0` 等价手段）

## 已知平台相关决策

- `tool-bash` 在 win32 被官方 patch `disabled`（DSH 官方行为）；本插件不依赖任何 shell。
- 环境变量白名单包含 Windows 专用项（SystemRoot/windir/ComSpec 等），POSIX 平台自动忽略缺失项。
- Node 版本要求 ≥20.11（DSH 本体要求 ^22.19 || >=24，运行 DSH 时以 DSH 的 engines 为准）。
