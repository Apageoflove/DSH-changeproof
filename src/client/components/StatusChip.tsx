import type { VerdictStatus } from "../../shared/status.ts";
import { STATUS_LABELS, STATUS_SEVERITY } from "../../shared/status.ts";
import styles from "../styles/proofboard.module.css";

/** Status glyph + text label; color is never the only carrier (12.1). */
const ICONS: Record<VerdictStatus, string> = {
  VERIFIED: "✓",
  PARTIAL: "◐",
  FAILED: "✕",
  STALE: "↻",
  UNVERIFIED: "?",
  NOT_APPLICABLE: "∅"
};

export function StatusChip(props: {
  status: VerdictStatus;
  pendingHostConfirmation?: boolean;
  evidenceAgeIso?: string | null;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { status, pendingHostConfirmation, evidenceAgeIso } = props;
  const severityClass =
    status === "VERIFIED" ? styles.severityOk
    : status === "FAILED" ? styles.severityError
    : status === "PARTIAL" || status === "STALE" ? styles.severityWarn
    : status === "NOT_APPLICABLE" ? styles.severityInfo
    : styles.severityMuted;
  const age = evidenceAgeIso ? evidenceAgeIso.slice(0, 19).replace("T", " ") + "Z" : null;
  return (
    <button
      type="button"
      className={`${styles.chip} ${severityClass}`}
      onClick={props.onOpen}
      aria-label={`ChangeProof 状态: ${STATUS_LABELS[status]}`}
      title={pendingHostConfirmation ? "代码已变化，需重验（等待 Host 确认）" : STATUS_LABELS[status]}
    >
      <span className={styles.chipIcon} aria-hidden="true">
        {ICONS[status]}
      </span>
      <span>{STATUS_LABELS[status]}</span>
      {pendingHostConfirmation ? <span aria-hidden="true">· 待确认</span> : null}
      {!props.compact && age ? <span className={styles.mono}>({age})</span> : null}
    </button>
  );
}

export { STATUS_SEVERITY };
