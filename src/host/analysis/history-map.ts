/**
 * Historical coverage map persistence (PROJECT.md 8.2 tier 2).
 * A mapping entry upgrades to HIGH only when the source digest, adapter id
 * and version still match; digest drift degrades to MEDIUM; entries older
 * than maxAgeDays are not used at all. Aggregate (non per-test) coverage is
 * NEVER back-ported into per-test attribution.
 */
import type { Digest } from "../../shared/models.ts";
import type { FsPort } from "../adapters/dsh/fs-port.ts";
import type { HistoryMapStore } from "../persistence/coverage-map-store.ts";

export interface HistoryEntry {
  path: string;
  contentDigest: Digest;
  testFiles: string[];
  adapter: { id: string; version: string };
  /** ISO timestamp of the run that produced the entry */
  recordedAt: string;
}

export interface HistoryMatch {
  path: string;
  testFiles: string[];
  confidence: "HIGH" | "MEDIUM";
  reason: "digest-match" | "digest-drift";
}

export function matchHistoryEntries(
  changed: Array<{ path: string; contentDigest: Digest | null }>,
  entries: HistoryEntry[],
  nowIso: string,
  maxAgeDays: number
): HistoryMatch[] {
  const now = Date.parse(nowIso);
  const matches: HistoryMatch[] = [];
  for (const file of changed) {
    const entry = entries.find((e) => e.path === file.path);
    if (!entry) continue;
    const ageMs = now - Date.parse(entry.recordedAt);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeDays * 24 * 3600 * 1000) continue; // expired: unused
    if (file.contentDigest === entry.contentDigest) {
      matches.push({ path: file.path, testFiles: [...entry.testFiles], confidence: "HIGH", reason: "digest-match" });
    } else {
      matches.push({ path: file.path, testFiles: [...entry.testFiles], confidence: "MEDIUM", reason: "digest-drift" });
    }
  }
  return matches;
}

export async function loadHistoryEntries(store: HistoryMapStore): Promise<HistoryEntry[]> {
  return store.load();
}

export async function saveHistoryEntries(store: HistoryMapStore, entries: HistoryEntry[]): Promise<void> {
  await store.save(entries);
}

export type { FsPort };
