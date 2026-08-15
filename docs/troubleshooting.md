# 故障排查

所有错误都有 `CP_*` 原因码；`changeproof_*` 工具失败时返回结构化 error（绝不靠抛异常向用户表达业务失败）。

| 原因码 / 现象 | 含义 | 处理 |
|---|---|---|
| `CP_CONFIG_NOT_FOUND` | 工作区没有 `.changeproof.yml` | 参考 docs/configuration.md 创建（插件不会代写） |
| `CP_CONFIG_INVALID` | 未知字段/类型错误/阈值越界/argv 是 shell 字符串 | 报错信息包含具体字段与期望 |
| `CP_PATH_ESCAPE` | cwd/coverageFile/产物路径逃逸工作区（含 symlink/junction 解析后逃逸） | 检查相对路径；不要用 junction 指向工作区外 |
| `CP_NOT_A_GIT_REPO` | 无 `.git` 或不可用 | ChangeSet 需要 Git 基线；非 Git → 永不 VERIFIED |
| `CP_COVERAGE_ARTIFACT_MISSING` | exit 0 但产物不存在 | 检查 test.argv 是否真的生成 coverageFile |
| `CP_COVERAGE_PARSE_ERROR` | 产物不是合法 JSON / 结构不符 | 查看诊断中的具体条目；不猜测 |
| `CP_COVERAGE_SCHEMA_UNKNOWN` | coverage.py format/version 不在支持集 | 用 6.x/7.x coverage.py；新版本需先扩 adapter+契约 |
| `CP_COVERAGE_RESOURCE_EXCEEDED` | 产物超大（>20MB 或条目超限） | 缩小 `--cov` 范围或调高 caps |
| `CP_IMPACT_LOW_CONFIDENCE` | 只有 LOW 置信度映射（命名约定层） | 添加 mappings 或保证 import 可静态解析 |
| `CP_COVERAGE_GAP_FILES` | 改动文件完全不在产物中 | runner 通常不插桩测试文件——为 fixture 提供测试文件覆盖或确认 `--cov` 范围包含该文件 |
| `CP_WORKSPACE_CHANGED_DURING_VERIFY` | 运行期间工作区被改动 | 消除并发写入；重跑 verify |
| `CP_FINGERPRINT_MISMATCH` | 证据绑定旧 fingerprint | 重新 `changeproof_verify`（最小计划重验） |

## 常见问题

**Q: verify 退出码 65？**
未加 `--yes`：CLI 只打印将执行的命令预览（含 REAL side effects 警告）。确认后加 `--yes`。

**Q: 改了测试文件却显示 coverage gap？**
runner 不对测试文件插桩，而测试文件的改动是 ChangeSet 的一部分——保守语义要求它在产物中出现。真实 vitest 场景把 `coverage.include` 设为覆盖测试文件，或在 fixture 的产物中包含测试文件条目（见 benchmark fixtures）。

**Q: untracked 新文件没有进 ChangeSet？**
未跟踪文件必须匹配某个 package 的 `include` glob 才纳入（避免把随便落盘的文件当变更）；不匹配时记录诊断。

**Q: STALE 反复出现？**
fingerprint 覆盖源文件/测试/lockfile/runner 配置/`.changeproof.yml`/adapter 版本/基线 commit——任何一项变化都应重验。若来自 Client 的保守标记（`CP_CLIENT_CONSERVATIVE_STALE`），跑一次 `changeproof_status` 由 Host 确认。

**Q: Windows 上 junction node_modules 被扫描进来了吗？**
不会：`node_modules`/`.git`/`coverage`/`.changeproof` 等目录在扫描层跳过；建议 fixture 提供 `.gitignore` 排除它们，避免污染 git 基线。
