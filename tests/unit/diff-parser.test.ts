import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@host/adapters/git/diff-parser.js";

describe("parseUnifiedDiff", () => {
  it("parses a modification hunk into added/modified/deleted ranges", () => {
    const diff = [
      "diff --git a/src/billing.ts b/src/billing.ts",
      "index 111..222 100644",
      "--- a/src/billing.ts",
      "+++ b/src/billing.ts",
      "@@ -10,2 +10,3 @@ export function refund() {",
      " context-line",
      "-removed-line",
      "+added-line-1",
      "+added-line-2",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.oldPath).toBe("src/billing.ts");
    expect(f.newPath).toBe("src/billing.ts");
    expect(f.status).toBe("modified");
    expect(f.linesAdded).toBe(2);
    expect(f.linesDeleted).toBe(1);
    // '+' lines after a '-' line in the same hunk => modified range on NEW file
    expect(f.ranges).toEqual([
      { startLine: 11, endLine: 11, kind: "deleted" },
      { startLine: 11, endLine: 12, kind: "modified" }
    ]);
  });

  it("pure addition hunk yields kind=added", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,4 @@",
      "+export const a = 1;",
      "+export const b = 2;",
      "+",
      "+export const c = 3;",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.ranges).toEqual([{ startLine: 1, endLine: 4, kind: "added" }]);
    expect(files[0]!.linesAdded).toBe(4);
  });

  it("deletion-only diff keeps old-file coordinates", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-line1",
      "-line2",
      "-line3",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    const f = files[0]!;
    expect(f.status).toBe("deleted");
    expect(f.ranges).toEqual([{ startLine: 1, endLine: 3, kind: "deleted" }]);
  });

  it("parses rename headers and hunks", () => {
    const diff = [
      "diff --git a/old.ts b/new-dir/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new-dir/new.ts",
      "@@ -5,1 +5,1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    const f = files[0]!;
    expect(f.status).toBe("renamed");
    expect(f.renameFrom).toBe("old.ts");
    expect(f.renameTo).toBe("new-dir/new.ts");
    expect(f.ranges).toEqual([
      { startLine: 5, endLine: 5, kind: "deleted" },
      { startLine: 5, endLine: 5, kind: "modified" }
    ]);
  });

  it("handles multiple contiguous hunks merging adjacent added ranges", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1,0 +2,2 @@",
      "+x",
      "+y",
      "@@ -8,0 +12,1 @@",
      "+z",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    // hunks at different positions must NOT merge
    expect(files[0]!.ranges).toEqual([
      { startLine: 2, endLine: 3, kind: "added" },
      { startLine: 12, endLine: 12, kind: "added" }
    ]);
  });

  it("handles '\\ No newline at end of file' markers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]!.linesAdded).toBe(1);
    expect(files[0]!.linesDeleted).toBe(1);
  });

  it("marks binary diffs and produces no ranges", () => {
    const diff = ["diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ", ""].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.ranges).toEqual([]);
  });

  it("fails loud on malformed hunk body", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,1 @@", "garbage-without-marker", ""].join("\n");
    expect(() => parseUnifiedDiff(diff)).toThrowError(/CP_DIFF_PARSE_ERROR/);
  });

  it("fails loud on content before any file header", () => {
    expect(() => parseUnifiedDiff("random content\n")).toThrowError(/CP_DIFF_PARSE_ERROR/);
  });

  it("unquotes non-ascii paths", () => {
    const diff = [
      'diff --git "a/\\346\\226\\207\\346\\234\\254.ts" "b/\\346\\226\\207\\346\\234\\254.ts"',
      "@@ -1,0 +1,1 @@",
      "+x",
      ""
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    // a/ b/ prefix strip works even with quoted names
    expect(files).toHaveLength(1);
  });
});
