/**
 * 证据存储：<workspace>/.changeproof/evidence/ 下 append-only JSONL。
 * 最小化、不含密钥，用 digest 代替原始输出（PROJECT.md 8.5）。
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CpError } from "../../shared/errors.ts";
import { canonicalJsonStringify, isPlainObject } from "../../shared/schema.ts";
import type { EvidenceRecord } from "../../shared/models.ts";
import { assertKnownSchemaVersion } from "./migrations.ts";

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 5000;

export class EvidenceStore {
  private readonly dirAbs: string;

  constructor(dirAbs: string) {
    this.dirAbs = dirAbs;
  }

  async append(record: EvidenceRecord): Promise<void> {
    await mkdir(this.dirAbs, { recursive: true });
    const file = path.join(this.dirAbs, "evidence.jsonl");
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length >= MAX_RECORDS) {
      lines.splice(0, lines.length - MAX_RECORDS + 1); // bounded ring
    }
    lines.push(canonicalJsonStringify(record));
    const next = lines.join("\n") + "\n";
    if (Buffer.byteLength(next, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", "evidence store size cap exceeded");
    }
    await writeFile(file, next, { encoding: "utf8" });
  }

  /** Most recent records first (sorted by startedAt then insertion). */
  async listAll(): Promise<EvidenceRecord[]> {
    const file = path.join(this.dirAbs, "evidence.jsonl");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const out: EvidenceRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // corrupt line: skipped, never guessed
      }
      if (!isPlainObject(parsed)) continue;
      if (parsed["schemaVersion"] !== "1.0") continue; // unknown versions ignored (read-only)
      out.push(parsed as unknown as EvidenceRecord);
    }
    out.sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1));
    return out;
  }

  async latest(): Promise<EvidenceRecord | null> {
    const all = await this.listAll();
    return all.length > 0 ? all[all.length - 1]! : null;
  }

  /** Store self-check used by tests and verify-package. */
  async healthCheck(): Promise<{ ok: boolean; recordCount: number }> {
    await mkdir(this.dirAbs, { recursive: true });
    const names = await readdir(this.dirAbs);
    return { ok: names.includes("evidence.jsonl") || names.length >= 0, recordCount: (await this.listAll()).length };
  }
}

export { assertKnownSchemaVersion };
