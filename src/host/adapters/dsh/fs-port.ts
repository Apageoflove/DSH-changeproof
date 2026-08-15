/**
 * 文件系统端口：工作区文件访问的唯一入口。
 * standalone 模式基于 node:fs/promises 实现，带读取上限和工作区路径检查。
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
  /** 解析真实路径；symlink/junction 逃逸工作区时报错。 */
  realpathInWorkspace(rootAbs: string, relPath: string): Promise<string>;
  /** 文件内容摘要，CRLF 归一为 LF（跨平台一致）。 */
  digestFileNormalized(absPath: string, maxBytes: number): Promise<Digest>;
  sizeOf(absPath: string): Promise<number>;
  isSymbolicLink(absPath: string): Promise<boolean>;
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 单文件读取上限

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
   * 校验工作区相对路径并解析真实路径。拒绝：
   *   - 绝对路径 / UNC / 设备名 / `..`（词法检查）
   *   - 解析 symlink/junction 后逃出工作区根（解析后再查一次，防 TOCTOU）
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
