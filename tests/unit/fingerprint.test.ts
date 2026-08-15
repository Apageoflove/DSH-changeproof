import { describe, expect, it } from "vitest";
import { computeFingerprint, diffFingerprintInputs } from "@host/analysis/fingerprint.js";
import { canonicalJsonStringify } from "@shared/schema.js";
import type { Digest, FingerprintInputs } from "@shared/models.js";

const hash = (s: string): Digest => (`sha256:${(() => {
  // tiny deterministic stand-in for sha256 in pure unit tests
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
})()}`);

const base: FingerprintInputs = {
  baselineCommit: "abc123",
  changeSetDigest: "sha256:cs",
  changedFileDigests: [{ path: "src/a.ts", digest: "sha256:d1" }],
  testFileDigests: [{ path: "src/a.test.ts", digest: "sha256:d2" }],
  lockfileDigests: [{ path: "pnpm-lock.yaml", digest: "sha256:d3" }],
  runnerConfigDigests: [{ path: "vitest.config.ts", digest: "sha256:d4" }],
  pluginConfigDigest: "sha256:d5",
  adapters: [{ id: "istanbul", version: "1.0" }]
};

describe("computeFingerprint", () => {
  it("is deterministic regardless of array order", () => {
    const shuffled: FingerprintInputs = {
      ...base,
      changedFileDigests: [...base.changedFileDigests].reverse(),
      adapters: [...base.adapters]
    };
    expect(computeFingerprint(base, hash)).toBe(computeFingerprint(shuffled, hash));
  });

  it("changes when any input changes", () => {
    const variants: FingerprintInputs[] = [
      { ...base, baselineCommit: "other" },
      { ...base, changeSetDigest: "sha256:other" },
      { ...base, changedFileDigests: [{ path: "src/a.ts", digest: "sha256:other" }] },
      { ...base, testFileDigests: [{ path: "src/a.test.ts", digest: "sha256:other" }] },
      { ...base, lockfileDigests: [{ path: "pnpm-lock.yaml", digest: "sha256:other" }] },
      { ...base, runnerConfigDigests: [{ path: "vitest.config.ts", digest: "sha256:other" }] },
      { ...base, pluginConfigDigest: "sha256:other" },
      { ...base, adapters: [{ id: "istanbul", version: "2.0" }] }
    ];
    const fp0 = computeFingerprint(base, hash);
    for (const v of variants) {
      expect(computeFingerprint(v, hash)).not.toBe(fp0);
    }
  });

  it("does not depend on absolute paths or local time", () => {
    const fp = computeFingerprint(base, hash);
    const canonical = canonicalJsonStringify({ ...base });
    expect(canonical).not.toMatch(/[A-Z]:\\/);
    expect(canonical).not.toMatch(/new Date/);
    expect(fp).toMatch(/^sha256:/);
  });
});

describe("diffFingerprintInputs", () => {
  it("reports which inputs changed", () => {
    const after: FingerprintInputs = {
      ...base,
      changedFileDigests: [{ path: "src/a.ts", digest: "sha256:changed" }],
      testFileDigests: [...base.testFileDigests, { path: "src/b.test.ts", digest: "sha256:new" }]
    };
    const diff = diffFingerprintInputs(base, after);
    expect(diff.some((d) => d.includes("changed source") && d.includes("src/a.ts"))).toBe(true);
    expect(diff.some((d) => d.includes("test file added") && d.includes("b.test.ts"))).toBe(true);
  });

  it("returns empty for identical inputs", () => {
    expect(diffFingerprintInputs(base, { ...base })).toEqual([]);
  });
});
