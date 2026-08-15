/**
 * File-system port: the single seam for workspace file access.
 * A real DSH host injects its own fs capability; in standalone (headless) mode
 * we implement the port over node:fs/promises with bounded reads and
 * workspace-jail checks.
 */
import { createHash } from "node:crypto";
import { realpath, stat, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { CpError } from "../../../shared/errors.ts";
import type { Digest } from "../../../shared/models.ts";

export interface FileContent {
  bytes: Uint8Array;
  truncated: boolean;
}

export interface FsPort {
  readFileBounded(absPath: string, maxBytes: number): Promise<FileContent>;
  exists(absPath: string): Promise<boolean>;
  /** Resolves symlinks/junctions; throws when the final path escapes root. */
  realpathInWorkspace(rootAbs: string, relPath: string): Promise<string>;
  /** Content digest of the file with CRLF normalized to LF (stable across platforms). */
  digestFileNormalized(absPath: string, maxBytes: number): Promise<Digest>;
  sizeOf(absPath: string): Promise<number>;
  isSymbolicLink(absPath: string): Promise<boolean>;
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB hard cap per file read

export class StandaloneFsPort implements FsPort {
  async readFileBounded(absPath: string, maxBytes: number): Promise<FileContent> {
    const st = await stat(absPath);
    if (!st.isFile()) throw new CpError("CP_PATH_NOT_FOUND", `not a regular file: ${absPath}`);
    if (st.size > maxBytes) {
      const fh = await import("node:fs/promises").then((m) => m.open(absPath, "r"));
      try {
        const buf = Buffer.alloc(maxBytes);
        await fh.read(buf, 0, maxBytes, 0);
        return { bytes: new Uint8Array(buf), truncated: true };
      } finally {
        await fh.close();
      }
    }
    const buf = await readFile(absPath);
    return { bytes: new Uint8Array(buf), truncated: false };
  }

  async exists(absPath: string): Promise<boolean> {
    try {
      await lstat(absPath);
      return true;
    } catch {
      return false;
    }
  }

  async isSymbolicLink(absPath: string): Promise<boolean> {
    try {
      const st = await lstat(absPath);
      return st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async sizeOf(absPath: string): Promise<number> {
    const st = await stat(absPath);
    return st.size;
  }

  /**
   * Validate a workspace-relative path and resolve its REAL path. Rejects:
   *   - absolute/UNC/device/`..` paths (lexical checks)
   *   - realpaths that escape the workspace root after symlink/junction
   *     resolution (TOCTOU-aware re-check after resolution)
   */
  async realpathInWorkspace(rootAbs: string, relPath: string): Promise<string> {
    const rootReal = await realpath(rootAbs);
    const lexicallySafe = path.resolve(rootReal, relPath);
    if (lexicallySafe !== rootReal && !lexicallySafe.startsWith(rootReal + path.sep)) {
      throw new CpError("CP_PATH_ESCAPE", `path escapes workspace: ${relPath}`);
    }
    let real: string;
    try {
      real = await realpath(lexicallySafe);
    } catch {
      throw new CpError("CP_PATH_NOT_FOUND", `path not found: ${relPath}`);
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new CpError("CP_PATH_ESCAPE", `resolved path escapes workspace (symlink/junction?): ${relPath}`);
    }
    return real;
  }

  async digestFileNormalized(absPath: string, maxBytes: number): Promise<Digest> {
    const { bytes } = await this.readFileBounded(absPath, maxBytes);
    const normalized = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
    return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  }
}

export function sha256Hex(data: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
