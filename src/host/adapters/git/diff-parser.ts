/**
 * Unified diff parser (pure function).
 * Produces per-file changed line ranges with 1-based inclusive coordinates.
 * Added/modified ranges refer to the NEW file; deleted ranges refer to the
 * OLD file (deleted lines never enter the coverage denominator — they form
 * deletedLineRisk instead; PROJECT.md 8.1 item 4).
 */
import { CpError } from "../../../shared/errors.ts";
import type { ChangedRange } from "../../../shared/models.ts";

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  renameFrom?: string;
  renameTo?: string;
  ranges: ChangedRange[];
  linesAdded: number;
  linesDeleted: number;
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function normalizeDiffPath(p: string): string {
  // strip a/ b/ prefixes and unquote
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      /* keep raw */
    }
  }
  if (p === "/dev/null") return "/dev/null";
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let i = 0;
  let current: FileDiff | null = null;

  const pushRange = (f: FileDiff, r: ChangedRange) => {
    if (r.startLine > r.endLine) return; // empty range
    const last = f.ranges[f.ranges.length - 1];
    if (
      last &&
      last.kind === r.kind &&
      r.startLine <= last.endLine + 1 &&
      r.startLine >= last.startLine &&
      r.endLine >= last.endLine
    ) {
      last.endLine = r.endLine; // merge contiguous
      return;
    }
    f.ranges.push(r);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        oldPath: m ? normalizeDiffPath("a/" + m[1]!) : null,
        newPath: m ? normalizeDiffPath("b/" + m[2]!) : null,
        status: "modified",
        ranges: [],
        linesAdded: 0,
        linesDeleted: 0,
        binary: false
      };
      files.push(current);
      i += 1;
      continue;
    }

    if (current) {
      if (line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("index ") || line.startsWith("similarity index") || line.startsWith("dissimilarity index")) {
        i += 1;
        continue;
      }
      if (line.startsWith("rename from ")) {
        current.renameFrom = normalizeDiffPath(line.slice("rename from ".length));
        current.status = "renamed";
        i += 1;
        continue;
      }
      if (line.startsWith("rename to ")) {
        current.renameTo = normalizeDiffPath(line.slice("rename to ".length));
        current.status = "renamed";
        i += 1;
        continue;
      }
      if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
        i += 1;
        continue;
      }
      if (line.startsWith("new file mode")) {
        current.status = "added";
        i += 1;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        current.status = "deleted";
        i += 1;
        continue;
      }
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
        current.binary = true;
        i += 1;
        continue;
      }
      if (line.startsWith("--- ")) {
        const p = normalizeDiffPath(line.slice(4).trim());
        if (p !== "/dev/null") current.oldPath = p;
        i += 1;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = normalizeDiffPath(line.slice(4).trim());
        if (p !== "/dev/null") current.newPath = p;
        i += 1;
        continue;
      }

      const hunk = line.match(HUNK_RE);
      if (hunk) {
        const oldStart = parseInt(hunk[1]!, 10);
        const oldCount = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
        const newStart = parseInt(hunk[3]!, 10);
        const newCount = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);
        i += 1;
        let oldLine = oldStart;
        let newLine = newStart;
        let oldLeft = oldCount;
        let newLeft = newCount;
        let addedRun: { start: number; end: number } | null = null;
        let deletedRun: { start: number; end: number } | null = null;
        let hunkHasDeletions = false;
        let hunkHasAdditions = false;

        const flushAdded = () => {
          if (!addedRun) return;
          pushRange(current!, {
            startLine: addedRun.start,
            endLine: addedRun.end,
            kind: hunkHasDeletions ? "modified" : "added"
          });
          addedRun = null;
        };
        const flushDeleted = () => {
          if (!deletedRun) return;
          pushRange(current!, { startLine: deletedRun.start, endLine: deletedRun.end, kind: "deleted" });
          deletedRun = null;
        };

        while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
          const raw = lines[i]!;
          const marker = raw[0];
          const content = raw.slice(1);
          if (marker === "+") {
            flushDeleted();
            if (addedRun) addedRun.end = newLine;
            else addedRun = { start: newLine, end: newLine };
            current!.linesAdded += 1;
            hunkHasAdditions = true;
            newLine += 1;
            newLeft -= 1;
            i += 1;
          } else if (marker === "-") {
            flushAdded();
            if (deletedRun) deletedRun.end = oldLine;
            else deletedRun = { start: oldLine, end: oldLine };
            current!.linesDeleted += 1;
            hunkHasDeletions = true;
            oldLine += 1;
            oldLeft -= 1;
            i += 1;
          } else if (marker === " ") {
            flushAdded();
            flushDeleted();
            oldLine += 1;
            newLine += 1;
            oldLeft -= 1;
            newLeft -= 1;
            i += 1;
          } else if (raw === "\\ No newline at end of file") {
            i += 1; // metadata line, consumes nothing
          } else {
            // Malformed hunk: stop and report instead of guessing.
            throw new CpError("CP_DIFF_PARSE_ERROR", `malformed hunk body at diff line ${i + 1}: ${JSON.stringify(raw.slice(0, 80))}`);
          }
        }
        flushAdded();
        flushDeleted();
        // cross-hunk merge: an "added" hunk following another added range
        if (current!.status !== "deleted" && current!.ranges.length >= 2) {
          const last = current!.ranges[current!.ranges.length - 1]!;
          const prev = current!.ranges[current!.ranges.length - 2]!;
          if (
            last.kind === prev.kind &&
            last.kind !== "deleted" &&
            last.startLine <= prev.endLine + 1 &&
            last.endLine >= prev.endLine
          ) {
            prev.endLine = last.endLine;
            current!.ranges.pop();
          }
        }
        continue;
      }
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // Unexpected top-level line outside a file header: fail loud.
    if (!current) {
      throw new CpError("CP_DIFF_PARSE_ERROR", `unexpected diff content before any file header: ${JSON.stringify(line.slice(0, 80))}`);
    }
    i += 1;
  }

  for (const f of files) {
    if (f.status === "renamed" && !f.renameTo) f.status = "modified";
    if (f.oldPath === "/dev/null" && f.newPath && f.status !== "added") f.status = "added";
    if (f.newPath === "/dev/null" && f.oldPath) f.status = "deleted";
  }
  return files;
}
