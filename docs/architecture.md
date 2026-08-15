# 架构

> ChangeProof（`dsh-changeproof`）：变更相关性 + 证据新鲜度的质量插件。

## 分层

```
┌───────────────────────────── Client（可选 Web Profile）─────────────────────────────┐
│ projection/canonical-result  只解析 Host 的规范化结果，绝不自行推断结论                  │
│ projection/freshness-reducer 折叠状态；观察到的 mutation 只能保守标 STALE（待确认）       │
│ components/Proofboard 等      语义化 HTML；数字优先；文字+图标+原因码，永不只靠颜色        │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ canonical JSON（schemaVersion 1.0）
┌──────────────────────────────────────▼──────────────────────────────────────────────┐
│                                      Host                                           │
│ tools: changeproof_plan / changeproof_verify / changeproof_status                   │
│ analysis: impact-resolver（四级来源）changed-lines fingerprint verdict(状态机)         │
│ execution: planner → executor（argv-only 子进程、超时、取消、输出上限、进程树终止）      │
│ persistence: evidence-store(JSONL) coverage-map-store migrations(只读拒绝未知版本)     │
│ adapters: git / istanbul / coverage.py / vitest-jest / pytest / import-graph(js,py)  │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ 唯一绑定层
┌──────────────────────────────────────▼──────────────────────────────────────────────┐
│                 adapters/dsh/ Compatibility Facade（capability probe）               │
│   有真实 DSH → 适配其公共能力；无 DSH → standalone 端口（headless 完整可用）            │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 关键决策

1. **一切结论绑定证据**：verdict 只由 EvidenceRecord 驱动；`exit 0` 本身不构成证据。
2. **fingerprint 先行**：workspace fingerprint 覆盖（变更源文件、相关测试、lockfile、runner 配置、`.changeproof.yml`、adapter 版本、基线 commit）。执行前算一次、执行后再算一次，两者不一致 → 全部证据作废（STALE），即使命令 exit 0。
3. **状态机有固定优先级**（PROJECT.md §7）：STALE → FAILED → UNVERIFIED(归因) → PARTIAL → VERIFIED；NOT_APPLICABLE 仅由带原因码的确定性规则产生。
4. **删除行永不计入分母**：删除风险单独记录，默认 PARTIAL，由相关测试/静态检查/mutation 佐证。
5. **判定底线**（不可协商）：
   - exit 0 但缺 coverage 产物 / 解析错误 / LOW 置信度映射 → 绝不 VERIFIED；
   - 非 Git 工作区 → 绝不 VERIFIED；
   - 绑定旧 fingerprint 的证据 → 一律 STALE。

## 执行流程（changeproof_verify）

```
load config → ChangeSet(git) → 扫描工作区 → impact(4级) → pre-fingerprint
  → plan(cheap → targeted-test(+产物) → changed-line-coverage 解析)
  → 执行（审批钩子、argv-only、cwd 牢笼、超时/取消、输出上限、进程树终止）
  → 解析产物（Istanbul/coverage.py）→ changed-line 覆盖率
  → post-fingerprint（运行期间变化 → 全作废）
  → verdict 状态机 → 持久化证据(JSONL, 摘要+digest, 不含原始输出)
```

## 数据模型

见 `src/shared/models.ts`（Digest/ChangeSet/ImpactCandidate/VerificationPlan/EvidenceRecord/Verdict）。
所有跨端数据均为规范 JSON（键排序、无 undefined），digest 一律 `sha256:` 前缀，经规范化字节（LF）计算。
