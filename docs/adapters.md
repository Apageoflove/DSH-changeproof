# 测试适配器

ChangeProof 不重造 runner：它调用项目自己的测试命令，解析其覆盖率产物。

## JS / TS

| adapter | 运行器 | 产物 | 解析 |
|---|---|---|---|
| `vitest-istanbul` | vitest（`--coverage`，v8 provider） | `coverage/coverage-final.json`（Istanbul 格式） | `src/host/adapters/javascript/istanbul.ts` |
| `jest-istanbul` | jest（`--coverage`） | 同上 | 同上 |

- 可执行行 = statementMap 完整跨度 ∪ fnMap/branchMap **起始行**（Istanbul 语义：fn/branch 以起始行为覆盖单元，避免把闭括号计入分母）。
- covered = `s/f/b` 计数 > 0 的对应行。
- 候选测试文件会追加到 argv 末尾（vitest/jest 支持文件参数实现最小集执行）；无法文件化时记录诊断并回退完整 argv。

**注意**：runner 默认不对测试文件插桩——改动**测试文件**会构成 coverage gap（保守语义：不隐身清零）。给 fixture 同时提供测试文件的覆盖即可（见 benchmark `renamed-file` case）。

## Python

| adapter | 运行器 | 产物 | 解析 |
|---|---|---|---|
| `pytest-coverage-json` | pytest + coverage.py（`--cov-report=json:...`） | `coverage.json`（format 3） | `src/host/adapters/python/coverage-json.ts` |

- 实测锚定：coverage **7.15.4**，`meta.format: 3`（整数），文件键使用操作系统分隔符（Windows 为 `\\`）——契约由 `fixtures/python-pytest/coverage.json`（真实产物）钉死。
- 可执行行 = `executed_lines ∪ missing_lines − excluded_lines`；covered = `executed_lines`。
- 导入解析：`from x.y import z` 按 package root 解析；`__import__`/importlib → incomplete（置信度上限 MEDIUM）。

## Impact 四级来源（置信度语义）

| 层 | 来源 | 置信度 |
|---|---|---|
| 1 | 显式 mappings（config） | HIGH（用户声明的穷尽映射） |
| 2 | 历史 coverage map | digest 匹配 → HIGH；漂移 → MEDIUM；过期 → 弃用 |
| 3 | 静态 import graph | MEDIUM（默认；动态导入/未解析说明符 → 明确降级说明） |
| 4 | 命名约定 | LOW（只是候选来源，永不冒充穷尽证明） |

规则：**改动且仍存在的测试文件本身就是合法候选**（新写/修改的测试是自己的证据）；已删除的测试文件不算。同一 (package, 测试集) 的候选合并，保留全部来源与理由。
