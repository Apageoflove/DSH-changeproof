import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalJsonStringify, normalizeWorkspacePath } from "@shared/schema.js";

describe("property: workspace path normalization", () => {
  it("never returns a path that can escape the workspace", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (raw) => {
        const n = normalizeWorkspacePath(raw);
        if (n === null) return true;
        // invariants of any accepted path
        expect(n).not.toMatch(/^\/|^[a-zA-Z]:|^\\\\|\.\./);
        expect(n.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")).toBe(true);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it("accepts and normalizes legitimate relative paths", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "src", "pkg-x", "file.ts", "v1.2"), { minLength: 1, maxLength: 6 }),
        (segs) => {
          const joined = segs.join("/");
          expect(normalizeWorkspacePath(joined)).toBe(joined);
          expect(normalizeWorkspacePath("./" + joined + "/")).toBe(joined);
          expect(normalizeWorkspacePath(segs.join("\\"))).toBe(joined);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("property: canonical JSON stability", () => {
  it("key order never affects the canonical form", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 12 }), fc.integer({ min: -1000, max: 1000 }), { minKeys: 1, maxKeys: 8 }),
        (obj) => {
          const keys = Object.keys(obj);
          const shuffledKeys = [...keys].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)); // reverse-ish order
          const shuffled: Record<string, number> = {};
          for (const k of shuffledKeys) shuffled[k] = obj[k]!;
          expect(canonicalJsonStringify(obj)).toBe(canonicalJsonStringify(shuffled));
        }
      ),
      { numRuns: 300 }
    );
  });

  it("drops undefined and rejects nothing deterministic", () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const value = JSON.parse(text);
        expect(canonicalJsonStringify(value)).toBe(canonicalJsonStringify(canonicalize(value)));
      }),
      { numRuns: 300 }
    );
  });

  it("never emits __proto__/constructor/prototype keys (prototype pollution guard)", () => {
    const evil = JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"ok":3}');
    const canonical = JSON.stringify(canonicalize(evil));
    expect(canonical).toBe('{"ok":3}');
  });
});
