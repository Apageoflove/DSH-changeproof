import styles from "../styles/proofboard.module.css";

export function VerifyDock(props: {
  onPlan?: () => void;
  onVerify?: () => void;
  onCancel?: () => void;
  running?: boolean;
  unverifiedHint?: boolean;
}) {
  return (
    <div className={styles.dock} role="toolbar" aria-label="ChangeProof 操作">
      <button type="button" className={styles.button} onClick={props.onPlan} disabled={props.running}>
        Plan（仅分析）
      </button>
      <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={props.onVerify} disabled={props.running}>
        {props.running ? "执行中…" : "Verify（执行测试，需审批）"}
      </button>
      {props.running && props.onCancel ? (
        <button type="button" className={styles.button} onClick={props.onCancel}>
          取消（终止进程树）
        </button>
      ) : null}
      {props.unverifiedHint ? <span aria-live="polite">当前改动尚未验证</span> : null}
    </div>
  );
}

export function SettingsSection(props: {
  configSource: string;
  packages: Array<{ id: string; root: string; adapter: string }>;
  thresholds: { changedLines: number; minimumImpactConfidence: string };
  exclude: string[];
}) {
  return (
    <section className={styles.section} aria-labelledby="cp-settings-title">
      <h3 id="cp-settings-title" className={styles.sectionTitle}>
        ChangeProof 设置
      </h3>
      <p>
        配置来源: <span className={styles.mono}>{props.configSource}</span>（插件不修改用户配置）
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Root</th>
            <th scope="col">Adapter</th>
          </tr>
        </thead>
        <tbody>
          {props.packages.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td className={styles.mono}>{p.root || "."}</td>
              <td className={styles.mono}>{p.adapter}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        changedLines 阈值: <span className={styles.mono}>{(props.thresholds.changedLines * 100).toFixed(0)}%</span> · 最低 impact 置信度:{" "}
        <span className={styles.mono}>{props.thresholds.minimumImpactConfidence}</span>
      </p>
      {props.exclude.length > 0 ? <p>排除规则（UI 中始终展示，不隐身）: {props.exclude.join(", ")}</p> : null}
    </section>
  );
}
