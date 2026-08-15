/**
 * Output limiter: bounded stdout/stderr with head+tail summary and digest of
 * the FULL output (PROJECT.md 8.4). Truncation is recorded — never silently
 * dropped, never written to the session as unbounded text.
 */
import type { Digest } from "../../shared/models.ts";
import { sha256Hex } from "../adapters/dsh/fs-port.ts";

export interface OutputLimits {
  maxBytes: number;
  maxLines: number;
}

export interface OutputSummary {
  truncated: boolean;
  totalBytes: number;
  headLines: string[];
  tailLines: string[];
}

export function summarizeOutput(text: string, limits: OutputLimits): { summary: OutputSummary; digest: Digest } {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const truncated = bytes > limits.maxBytes || lines.length > limits.maxLines;
  const keepHead = Math.min(limits.maxLines, Math.floor(limits.maxLines * 0.7));
  const keepTail = Math.min(limits.maxLines - keepHead, Math.floor(limits.maxLines * 0.3));
  let headLines = lines.slice(0, keepHead);
  let tailLines = lines.length > keepHead + keepTail ? lines.slice(lines.length - keepTail) : [];
  if (truncated && tailLines.length === 0 && lines.length > keepHead) {
    tailLines = lines.slice(lines.length - keepTail);
  }
  // byte-bounded too
  const joinBytes = (arr: string[]) => Buffer.byteLength(arr.join("\n"), "utf8");
  while (joinBytes(headLines) + joinBytes(tailLines) > limits.maxBytes && headLines.length > 0) {
    if (headLines.length > tailLines.length) headLines = headLines.slice(0, Math.floor(headLines.length / 2));
    else tailLines = tailLines.slice(Math.ceil(tailLines.length / 2));
  }
  return {
    summary: { truncated, totalBytes: bytes, headLines, tailLines },
    digest: sha256Hex(text)
  };
}
