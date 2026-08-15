import type { EvidenceRecord } from "../../shared/models.ts";
import type { FileCoverage } from "../../shared/models.ts";
import type { VerdictReason } from "../../shared/models.ts";
import styles from "../styles/proofboard.module.css";

export function CoverageTable(props: { files: FileCoverage[]; summary: { covered: number; coverable: number; uncovered: number; ratio: number | null } }) {
  return (
    <section className={styles.section} aria-labelledby="cp-cov-title">
      <h3 id="cp-cov-title" className={styles.sectionTitle}>
        Changed-line coverage: {props.summary.ratio === null ? "无数据" : `${props.summary.covered}/${props.summary.coverable} (${(props.summary.ratio * 100).toFixed(1)}%)`}
      </h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">文件</th>
            <th scope="col">覆盖 / 可执行</th>
            <th scope="col">未覆盖行</th>
          </tr>
        </thead>
        <tbody>
          {props.files.map((f) => (
            <tr key={f.path}>
              <td className={styles.mono}>
                {f.path}
                {f.excluded ? `（已排除: ${f.excluded}）` : ""}
                {f.absentFromArtifact ? "（未出现在 coverage 产物中）" : ""}
              </td>
              <td className={styles.mono}>
                {f.covered.length}/{f.coverable.length}
              </td>
              <td className={styles.mono}>{f.uncovered.length > 0 ? f.uncovered.join(", ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function EvidenceTimeline(props: { evidence: EvidenceRecord[] }) {
  return (
    <section className={styles.section} aria-labelledby="cp-ev-title">
      <h3 id="cp-ev-title" className={styles.sectionTitle}>
        证据时间线
      </h3>
      {props.evidence.length === 0 ? (
        <p className={styles.empty}>尚无证据</p>
      ) : (
        <ol>
          {props.evidence.map((e) => (
            <li key={e.id}>
              <span className={styles.mono}>{e.stepId}</span> · {e.termination}
              {e.exitCode !== null ? `(${e.exitCode})` : ""} · {e.durationMs}ms · cwd=<span className={styles.mono}>{e.cwd || "."}</span>
              <br />
              argv: <span className={styles.mono}>{e.argvRedacted.join(" ")}</span>
              <br />
              artifact: <span className={styles.mono}>{e.artifactDigests.map((a) => `${a.kind}:${a.digest.slice(7, 19)}`).join(", ") || "—"}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function BlockerList(props: { blockers: VerdictReason[] }) {
  const needsUser = props.blockers.filter((b) => b.code.startsWith("CP_CONFIG") || b.code.includes("APPROVAL") || b.code.includes("NOT_FOUND"));
  const retryable = props.blockers.filter((b) => b.code === "CP_WORKSPACE_CHANGED_DURING_VERIFY" || b.code === "CP_FINGERPRINT_MISMATCH" || b.code === "CP_CLIENT_CONSERVATIVE_STALE");
  const capability = props.blockers.filter((b) => !needsUser.includes(b) && !retryable.includes(b));
  return (
    <section className={styles.section} aria-labelledby="cp-blocker-title">
      <h3 id="cp-blocker-title" className={styles.sectionTitle}>
        阻塞原因
      </h3>
      {props.blockers.length === 0 ? (
        <p className={styles.empty}>无阻塞</p>
      ) : (
        <>
          {needsUser.length > 0 ? (
            <div>
              <strong>需要用户处理</strong>
              <ul>
                {needsUser.map((b) => (
                  <li key={b.code + b.message} className={styles.blocker}>
                    <span className={styles.mono}>{b.code}</span> {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {retryable.length > 0 ? (
            <div>
              <strong>可自动重试（重验最小计划）</strong>
              <ul>
                {retryable.map((b) => (
                  <li key={b.code + b.message} className={styles.blocker}>
                    <span className={styles.mono}>{b.code}</span> {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {capability.length > 0 ? (
            <div>
              <strong>能力/证据缺口</strong>
              <ul>
                {capability.map((b) => (
                  <li key={b.code + b.message} className={styles.blocker}>
                    <span className={styles.mono}>{b.code}</span> {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
