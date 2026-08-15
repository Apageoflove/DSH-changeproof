# 配置参考（.changeproof.yml）

完整示例见 [PROJECT.md §13]；本文件描述校验规则与语义。所有非法配置 **fail loud**（`CP_CONFIG_INVALID` / `CP_PATH_ESCAPE`），绝不静默回退。

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| schemaVersion | `1` | 必填 | 版本 gate，其他值拒绝 |
| baseline | `{kind: head\|merge-base, ref?}` | head | merge-base 需提供 ref（默认 `origin/main`），失败回退 HEAD 并记录诊断 |
| packages | Package[] | 必填 | package root 之间禁止嵌套（歧义 fail loud） |
| checks | Check[] | `[]` | cheap / targeted-test 层 |
| mappings | Mapping[] | `[]` | 显式映射（HIGH 置信度来源） |
| coverage | 见下 | 见下 | 覆盖率行为 |
| thresholds | 见下 | `{changedLines: 1.0, minimumImpactConfidence: MEDIUM}` | changedLines ∈ [0,1] |
| exclude | glob[] | `[]` | 排除规则在 UI 中始终展示，从不"隐身" |

## Package

```yaml
- id: web                      # 唯一
  root: packages/web           # 工作区相对路径；"" = 整仓库单包
  languages: [typescript]      # typescript | javascript | python
  include: [packages/web/src/**/*.ts]   # 匹配源码范围；package root 下
                               # 的测试文件（*.test.ts / test_*.py / tests/**）
                               # 也会被扫描为候选，即使 include 只列源码
  test:
    adapter: vitest-istanbul   # vitest-istanbul | jest-istanbul | pytest-coverage-json
    argv: [pnpm, vitest, run, --coverage]   # argv 数组，绝不允许 shell 字符串
    cwd: packages/web          # 工作区相对（symlink/jacket 校验）
    timeoutMs: 120000          # (0, 3600000]
    coverageFile: packages/web/coverage/coverage-final.json
```

路径规则（`CP_PATH_ESCAPE`）：禁止 `..`、绝对路径、UNC、盘符、Windows 设备名（CON/COM1…）；执行前对 cwd 做 realpath 二次校验（防 TOCTOU / junction 逃逸）。

argv 规则：非空字符串数组；包含 `&&`、`||`、换行的元素会被拒绝（"npm test && curl …" 不是 argv）。

## 覆盖率语义

- `changedLinesOnly: true`（默认）：分母 = **本次改动行**中被 adapter 可靠识别为可执行的行；注释/空行天然不在 statement/fn/branch map 中。
- `requireArtifact: true`（默认）：exit 0 但无产物 → UNVERIFIED。
- 完全不在产物中的改动文件 = coverage gap → 至少降为 UNVERIFIED/PARTIAL（分母绝不静默清零）。
- `historyMap.enabled`：开启后验证成功的映射会记录到 `.changeproof/coverage-map.json`（digest 匹配 → HIGH；漂移 → MEDIUM；过期不使用）。聚合覆盖率**不会**被反向归因到单个测试。

## 证据与持久化

- `.changeproof/evidence/evidence.jsonl`：append-only，只存 digest/摘要/时间/argv（脱敏），不存原始输出。
- 未知 schemaVersion 的存储记录：读取侧拒绝（只读降级），绝不猜测字段。

## Headless / CI

```
node dist/host/cli.mjs plan   --workspace <abs>
node dist/host/cli.mjs verify --workspace <abs> [--yes]   # 不加 --yes 仅打印预览并退出 65
node dist/host/cli.mjs status --workspace <abs>
```

退出码（EXIT_POLICY）：VERIFIED/NOT_APPLICABLE=0，FAILED=1，STALE=2，PARTIAL=3，UNVERIFIED=4。
