/**
 * Workspace fingerprint (PROJECT.md 8.6).
 * Any change to a changed source file, related test file, lockfile,
 * runner/coverage config, plugin config or adapter version invalidates
 * evidence bound to an older fingerprint.
 */
import type { Digest, FingerprintInputs } from "../../shared/models.ts";
import { canonicalJsonStringify } from "../../shared/schema.ts";

export type HashFn = (s: string) => Digest;

/**
 * Deterministic fingerprint over stable inputs. No absolute paths, no local
 * time, no object insertion order (canonical JSON).
 */
export function computeFingerprint(inputs: FingerprintInputs, hash: HashFn): Digest {
  const payload = {
    schemaVersion: "1.0",
    baselineCommit: inputs.baselineCommit,
    changeSetDigest: inputs.changeSetDigest,
    changedFileDigests: [...inputs.changedFileDigests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    testFileDigests: [...inputs.testFileDigests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    lockfileDigests: [...inputs.lockfileDigests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    runnerConfigDigests: [...inputs.runnerConfigDigests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    pluginConfigDigest: inputs.pluginConfigDigest,
    adapters: [...inputs.adapters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : 1))
  };
  return hash(canonicalJsonStringify(payload));
}

/** Which fingerprint inputs changed between two snapshots (for STALE reasons). */
export function diffFingerprintInputs(
  before: FingerprintInputs,
  after: FingerprintInputs
): string[] {
  const changed: string[] = [];
  if (before.baselineCommit !== after.baselineCommit) changed.push(`baseline commit ${before.baselineCommit} → ${after.baselineCommit}`);
  if (before.changeSetDigest !== after.changeSetDigest) changed.push("ChangeSet digest");
  const byPath = (arr: Array<{ path: string; digest: Digest | null }>) => new Map(arr.map((x) => [x.path, x.digest]));
  const compareSets = (
    label: string,
    a: Array<{ path: string; digest: Digest | null }>,
    b: Array<{ path: string; digest: Digest | null }>
  ) => {
    const ma = byPath(a);
    const mb = byPath(b);
    for (const [p, d] of ma) {
      if (!mb.has(p)) changed.push(`${label} removed: ${p}`);
      else if (mb.get(p) !== d) changed.push(`${label} changed: ${p}`);
    }
    for (const p of mb.keys()) if (!ma.has(p)) changed.push(`${label} added: ${p}`);
  };
  compareSets("changed source", before.changedFileDigests, after.changedFileDigests);
  compareSets("test file", before.testFileDigests, after.testFileDigests);
  compareSets("lockfile", before.lockfileDigests, after.lockfileDigests);
  compareSets("runner config", before.runnerConfigDigests, after.runnerConfigDigests);
  if (before.pluginConfigDigest !== after.pluginConfigDigest) changed.push(".changeproof.yml");
  const adapterKey = (x: { id: string; version: string }) => `${x.id}@${x.version}`;
  const sa = new Set(before.adapters.map(adapterKey));
  const sb = new Set(after.adapters.map(adapterKey));
  if (sa.size !== sb.size || [...sa].some((k) => !sb.has(k))) changed.push("adapter version set");
  return changed;
}
