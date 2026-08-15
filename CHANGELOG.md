# Changelog

## 0.1.0 (2026-08-15)

首次可用版本（MVP 全量交付）。

### Host
- 三工具：`changeproof_plan`（仅分析）/ `changeproof_verify`（分层执行+证据）/ `changeproof_status`（fingerprint 复核）
- 六态 verdict 状态机（STALE→FAILED→UNVERIFIED→PARTIAL→VERIFIED + 确定性 NOT_APPLICABLE），全部带原因码
- workspace fingerprint：源/测试/lockfile/runner 配置/插件配置/adapter 版本/基线 commit；执行前后双采样
- impact 四级来源：显式映射(HIGH) / 历史 coverage map(HIGH|MEDIUM) / 静态 import graph(MEDIUM) / 命名约定(LOW)
- changed-line coverage：Istanbul `coverage-final.json` 与 coverage.py JSON（format 3）双 adapter；删除行独立风险记录
- 执行层：argv-only、cwd 牢笼（realpath 二次校验）、环境白名单、超时+进程树终止（taskkill /T/F 与进程组）、输出上限+digest、审批预览钩子
- 持久化：append-only 证据 JSONL（脱敏摘要）、coverage-map 存储、未知 schema 只读拒绝

### Client
- 投影层：canonical 结果解析（未知版本 fail loud）+ freshness reducer（观察到的 mutation 只保守标 STALE）
- Proofboard 组件族 + CSS Modules（light/dark token、两列宽屏、focus-visible）；数字优先、文字+图标+原因码

### DSH 兼容
- `src/host/adapters/dsh/` 唯一绑定层 + capability 探测（standalone 回退，headless 完整）
- `cordis.patch.yml`：Host 服务 + 工具注册 + Client 槽位声明；不 patch 核心，卸载零残留

### 测试与基准（全部实测）
- 163 项测试通过：单元/属性(fast-check)/契约(真实产物钉死)/集成(真实 vitest、真实 pytest+coverage.py)/E2E(headless CLI 全流程)/视觉/无障碍/安全
- 31 项基准 31/31：12 个 exit-0 假绿全部识破，0 静默失败，中位 ~0.6s/case
