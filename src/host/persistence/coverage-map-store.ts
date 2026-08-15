/**
 * Coverage-map store: versioned JSON under <workspace>/.changeproof/.
 * Records per-source-file test associations observed during verified runs
 * (explicit/import-graph derived), used by the tier-2 history impact source.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryEntry } from "../analysis/history-map.ts";
import { assertKnownSchemaVersion, safeParseKnownVersion } from "./migrations.ts";

export interface HistoryMapStore {
  load(): Promise<HistoryEntry[]>;
  save(entries: HistoryEntry[]): Promise<void>;
}

interface Container {
  schemaVersion: "1.0";
  entries: HistoryEntry[];
}

export class JsonHistoryMapStore implements HistoryMapStore {
  private readonly fileAbs: string;

  constructor(fileAbs: string) {
    this.fileAbs = fileAbs;
  }

  async load(): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.fileAbs, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return []; // corrupt store behaves as empty (rebuildable data)
    }
    const safe = safeParseKnownVersion(parsed, "coverage-map store");
    if (!safe || !Array.isArray(safe["entries"])) return [];
    return (safe["entries"] as HistoryEntry[]).filter((e) => typeof e?.path === "string" && Array.isArray(e.testFiles));
  }

  async save(entries: HistoryEntry[]): Promise<void> {
    const container: Container = {
      schemaVersion: "1.0",
      entries: entries.map((e) => ({ ...e, testFiles: [...new Set(e.testFiles)].sort() }))
    };
    await mkdir(path.dirname(this.fileAbs), { recursive: true });
    await writeFile(this.fileAbs, JSON.stringify(container, null, 2), { encoding: "utf8" });
    assertKnownSchemaVersion(container, "coverage-map store");
  }
}
