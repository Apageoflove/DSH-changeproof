import type { ClientState } from "../projection/freshness-reducer.ts";
import { StatusChip } from "./StatusChip.tsx";
import { ChangeSummary, ImpactList } from "./ChangeSummary.tsx";
import { CoverageTable, EvidenceTimeline, BlockerList } from "./CoverageTable.tsx";
import styles from "../styles/proofboard.module.css";

export interface ProofboardData {
  changeSet: {
    mode: "git" | "degraded";
    files: Array<{ path: string; status: string; linesAdded: number; linesDeleted: number }>;
    deletedLineRisk: Array<{ path: string; ranges: string[] }>;
  };
  candidates: Parameters<typeof ImpactList>[0]["candidates"];
  maxConfidence: string;
  coverageFiles: Parameters<typeof CoverageTable>[0]["files"];
  coverageSummary: { covered: number; coverable: number; uncovered: number; ratio: number | null };
  evidence: Parameters<typeof EvidenceTimeline>[0]["evidence"];
}

/**
 * Proofboard: the engineering review console (PROJECT.md 12).
 * All states render: empty / loading / awaiting-approval / running /
 * cancelled / failed / parser-error / no-coverage / stale / non-Git /
 * verified. Status is text + icon + reason code, never color alone.
 */
export function Proofboard(props: { state: ClientState; data: ProofboardData | null; loading?: boolean; theme?: "light" | "dark"; onReverify?: () => void }) {
  const { state, data, loading } = props;
  return (
    <div
      className={styles.board}
      data-cp-theme={props.theme ?? "light"}
      data-cp-status={state.status ?? "EMPTY"}
      data-cp-loading={loading ? "true" : "false"}
      role="region"
      aria-label="ChangeProof Proofboard"
    >
      <span className={styles.announcement} role="status" aria-live="polite">
        {loading ? "正在验证" : state.status ? `当前状态 ${state.status}` : "尚未验证"}
      </span>

      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          justifyContent: "space-between",
          flexWrap: "wrap"
        }}
      >
        {state.status ? (
          <StatusChip status={state.status} pendingHostConfirmation={state.pendingHostConfirmation} evidenceAgeIso={state.evidenceAgeIso} />
        ) : (
          <span className={styles.empty}>首次使用：点击 Plan 分析当前变更</span>
        )}
        {state.status === "STALE" && props.onReverify ? (
          <button type="button" className={styles.button} onClick={props.onReverify}>
            重验（最小计划）
          </button>
        ) : null}
      </header>

      {state.errorMessage ? (
        <p role="alert" className={`${styles.chip} ${styles.severityError}`}>
          {state.errorMessage}
        </p>
      ) : null}

      {loading ? <p aria-live="polite">分析中…（不执行项目代码）</p> : null}

      {state.coverageSummary ? (
        <p>
          覆盖 <strong>{state.coverageSummary.covered}/{state.coverageSummary.coverable}</strong> changed executable lines
          {state.coverageSummary.uncovered > 0 ? `，未覆盖 ${state.coverageSummary.uncovered} 行` : ""}
        </p>
      ) : null}

      {data ? (
        <div className={styles.boardWide}>
          <ChangeSummary files={data.changeSet.files} deletedLineRisk={data.changeSet.deletedLineRisk} mode={data.changeSet.mode} />
          <ImpactList candidates={data.candidates} maxConfidence={data.maxConfidence} />
          <CoverageTable files={data.coverageFiles} summary={data.coverageSummary} />
          <EvidenceTimeline evidence={data.evidence} />
        </div>
      ) : (
        <p className={styles.empty}>无数据：运行 Plan 或 Verify 后显示变更、候选测试、覆盖与证据。</p>
      )}

      <BlockerList blockers={state.blockers} />
    </div>
  );
}
