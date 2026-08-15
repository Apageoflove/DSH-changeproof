import type { ImpactCandidate } from "../../shared/models.ts";
import styles from "../styles/proofboard.module.css";

export function ChangeSummary(props: {
  files: Array<{ path: string; status: string; linesAdded: number; linesDeleted: number }>;
  deletedLineRisk: Array<{ path: string; ranges: string[] }>;
  mode: "git" | "degraded";
}) {
  return (
    <section className={styles.section} aria-labelledby="cp-change-title">
      <h3 id="cp-change-title" className={styles.sectionTitle}>
        变更摘要 ({props.files.length} 个文件 · {props.mode === "git" ? "Git 基线" : "非 Git 降级（不可 VERIFIED）"})
      </h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">文件</th>
            <th scope="col">状态</th>
            <th scope="col">+/-</th>
          </tr>
        </thead>
        <tbody>
          {props.files.map((f) => (
            <tr key={f.path}>
              <td className={styles.mono}>{f.path}</td>
              <td>{f.status}</td>
              <td className={styles.mono}>
                +{f.linesAdded}/-{f.linesDeleted}
              </td>
            </tr>
          ))}
          {props.files.length === 0 ? (
            <tr>
              <td colSpan={3} className={styles.empty}>
                工作区无变更
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {props.deletedLineRisk.length > 0 ? (
        <p>
          删除风险（删除行无法被覆盖证明，需相关测试/静态检查/mutation 佐证）：
          {props.deletedLineRisk.map((d) => ` ${d.path} [${d.ranges.join(", ")}]`)}
        </p>
      ) : null}
    </section>
  );
}

export function ImpactList(props: { candidates: ImpactCandidate[]; maxConfidence: string }) {
  const byPackage = new Map<string, ImpactCandidate[]>();
  for (const c of props.candidates) {
    if (!byPackage.has(c.packageId)) byPackage.set(c.packageId, []);
    byPackage.get(c.packageId)!.push(c);
  }
  const sourceLabels: Record<string, string> = {
    explicit: "显式映射",
    "coverage-history": "历史 coverage map",
    "import-graph": "静态 import graph",
    naming: "命名约定"
  };
  return (
    <section className={styles.section} aria-labelledby="cp-impact-title">
      <h3 id="cp-impact-title" className={styles.sectionTitle}>
        候选测试 (最高置信度: {props.maxConfidence})
      </h3>
      {props.candidates.length === 0 ? (
        <p className={styles.empty}>无候选：相关测试未被找到，结论不会是 VERIFIED</p>
      ) : (
        <ul>
          {[...byPackage.entries()].map(([pkg, cands]) => (
            <li key={pkg}>
              <strong>{pkg}</strong>
              <ul>
                {cands.map((c) => (
                  <li key={c.id}>
                    <span className={styles.mono}>{c.testFiles.join(", ")}</span> — {sourceLabels[c.source] ?? c.source} ({c.confidence})
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
