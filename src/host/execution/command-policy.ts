/**
 * 命令策略：argv-only 执行、cwd 工作区牢笼、环境白名单、显式预览
 * （PROJECT.md 8.4, 14）。纯校验 + 预览构建；realpath 校验在 spawn
 * 前经 FsPort 做（TOCTOU 复检）。
 */
import { CpError } from "../../shared/errors.ts";

/** Shells require explicit opt-in and are flagged high risk for approval. */
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

export const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "ComSpec",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
  "CI",
  // git 官方变量：限制仓库向上查找（嵌套仓库/测试隔离用）
  "GIT_CEILING_DIRECTORIES"
]);

export interface CommandCheckInput {
  argv: string[];
  cwdRel: string; // workspace-relative POSIX ("" = root)
  timeoutMs: number;
  expectedArtifacts: string[];
}

export interface CommandPreview {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  envKeys: string[];
  expectedArtifacts: string[];
  riskLevel: "normal" | "high";
  warnings: string[];
}

export function checkCommand(input: CommandCheckInput): CommandPreview {
  const { argv, cwdRel } = input;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CpError("CP_COMMAND_POLICY_REJECTED", "argv must be a non-empty array");
  }
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0) {
      throw new CpError("CP_COMMAND_POLICY_REJECTED", "argv entries must be non-empty strings");
    }
    if (a.includes("\0")) {
      throw new CpError("CP_COMMAND_POLICY_REJECTED", "argv entries must not contain NUL");
    }
  }
  if (typeof cwdRel !== "string" || cwdRel.includes("..") || /^[a-zA-Z]:/.test(cwdRel) || cwdRel.startsWith("/")) {
    throw new CpError("CP_PATH_ESCAPE", `cwd escapes workspace: ${cwdRel}`);
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 3_600_000) {
    throw new CpError("CP_COMMAND_POLICY_REJECTED", "timeoutMs must be in (0, 3600000]");
  }

  const warnings: string[] = [];
  const exe = argv[0]!.toLowerCase().replace(/\.exe$/, "");
  const base = exe.split(/[\\/]/).pop()!;
  let riskLevel: "normal" | "high" = "normal";
  if (SHELL_EXECUTABLES.has(base)) {
    riskLevel = "high";
    warnings.push(
      `argv[0] "${argv[0]}" is a shell: the full command line will be shown for approval; project tests may have real side effects (writes, deletes, network)`
    );
  }
  for (const a of argv.slice(1)) {
    if (/&&|\|\||\n|\r/.test(a)) {
      throw new CpError("CP_COMMAND_POLICY_REJECTED", `argv entry contains shell control characters: "${a.slice(0, 60)}"`);
    }
  }

  return {
    argv: [...argv],
    cwd: cwdRel,
    timeoutMs: input.timeoutMs,
    envKeys: [...ENV_ALLOWLIST],
    expectedArtifacts: [...input.expectedArtifacts],
    riskLevel,
    warnings
  };
}

/** Redact likely secrets in argv for evidence records. */
export function redactArgv(argv: string[]): string[] {
  const sensitiveFlag = /^--?(?:token|secret|password|passwd|api[-_]?key|key|auth)$/i;
  const sensitiveInline = /^--?(?:token|secret|password|passwd|api[-_]?key|key|auth)=/i;
  return argv.map((a, i) => {
    if (sensitiveFlag.test(a)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        // value is redacted IN PLACE on the next element (see below)
        return a;
      }
      return a;
    }
    if (sensitiveInline.test(a) || /^(?:token|secret|password|apikey)=/i.test(a)) {
      return `${a.split("=")[0]}=***`;
    }
    // bare sensitive flag: the FOLLOWING element is its value -> mask it
    const prev = argv[i - 1];
    if (prev !== undefined && sensitiveFlag.test(prev) && !a.startsWith("-")) {
      return "***";
    }
    return a;
  });
}

export function buildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}
