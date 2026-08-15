# 安全

## 执行边界（PROJECT.md §14）

- **argv-only**：命令是字符串数组，从不拼接 shell 字符串；含 `&&`/`||`/换行的 argv 元素在配置层即拒绝。
- **cwd 牢笼**：cwd 必须是工作区相对路径；spawn 前做 realpath 二次校验（词法检查 + 解析后再检查，防 TOCTOU / junction 逃逸，`CP_PATH_ESCAPE`）。
- **环境变量白名单**：只透传 PATH/SystemRoot/TEMP 等系统必需项；token/secret 一律不继承（`ENV_ALLOWLIST`）。
- **审批预览**：执行前展示完整 argv/cwd/timeout/期望产物；shell 可执行文件标记 `riskLevel: high`；CLI 无 `--yes` 时只打印预览并以 65 退出。
- **超时与进程树终止**：Windows `taskkill /T /F`，POSIX 进程组 SIGKILL；安全测试验证孙进程也被收割，无孤儿。
- **输出上限**：stdout/stderr 截断为头+尾摘要（`truncated` 显式标记），完整输出只保留 sha256 digest。
- **资源上限**：产物读取 ≤20MB、文件条目数/行数上限、evidence 存储上限——超限是明确错误，不是猜测。

## 覆盖率产物 = 不可信输入

- JSON 解析失败、结构不符、`__proto__`/`constructor`/`prototype` 键、非并行 branch 计数、越界行号、未知 schema 版本 → 一律 `CP_COVERAGE_*` 错误，结论绝不可能是 VERIFIED。
- 产物键里的绝对路径只接受工作区内路径；`D:/evil/...`、`/etc/...`、`../...` 拒绝并记录诊断。
- 原型污染防护：canonicalize 丢弃危险键（属性测试覆盖）。

## 数据与持久化

- 证据 JSONL 只存 digest/摘要/时间戳/脱敏 argv（`--token abc` → `--token ***`）；不落盘原始输出。
- 插件**从不**写入用户的 `.changeproof.yml`、项目配置或 lockfile；持久化只发生在工作区 `.changeproof/` 目录。
- 未知存储 schema 版本 → 读取侧只读拒绝。

## 硬性红线（测试钉死）

1. exit 0 但无产物/解析错误 → UNVERIFIED（benchmark: no-artifact, corrupt-artifact 等 12 个假绿 case 全部被识破，0 静默失败）。
2. 非 Git 工作区 → 永不 VERIFIED。
3. 运行期间工作区变化 → 证据作废（STALE），即使 exit 0。
4. STALE 在 UI 中永不显示为绿色；数字优先，颜色永不单独承载语义。
