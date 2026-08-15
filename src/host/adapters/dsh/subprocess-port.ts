/**
 * 子进程端口：受控的 argv 执行（超时、取消、进程树终止）。
 * standalone 模式直接用 node:child_process，依然是 argv-only，绝不拼 shell 字符串。
 */
import { spawn } from "node:child_process";
import { CpError } from "../../../shared/errors.ts";
import type { Termination } from "../../../shared/models.ts";
import { killProcessTree } from "../../execution/process-tree.ts";

export interface ExecuteRequest {
  argv: string[];
  cwdAbs: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>; // 白名单，不继承完整环境
  abortSignal?: AbortSignal;
}

export interface ExecuteResult {
  exitCode: number | null;
  termination: Termination;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface SubprocessPort {
  execute(req: ExecuteRequest): Promise<ExecuteResult>;
}

export class StandaloneSubprocessPort implements SubprocessPort {
  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const { argv, cwdAbs, timeoutMs, maxOutputBytes, env, abortSignal } = req;
    if (argv.length === 0 || argv.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new CpError("CP_COMMAND_POLICY_REJECTED", "argv must be a non-empty array of non-empty strings");
    }
    if (argv.some((a) => a.includes("\0"))) {
      throw new CpError("CP_COMMAND_POLICY_REJECTED", "argv entries must not contain NUL");
    }

    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: cwdAbs,
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32" // own process group on POSIX for tree kill
      });
    } catch (err) {
      return {
        exitCode: null,
        termination: "spawn-error",
        stdout: "",
        stderr: String(err),
        durationMs: Date.now() - started,
        truncated: false
      };
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let termination: Termination = "exit";
    let exitCode: number | null = null;

    const appendBounded = (chunk: Buffer, current: string): string => {
      if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
        truncated = true;
        const room = Math.max(0, maxOutputBytes - (stdout.length + stderr.length) - current.length);
        return current + chunk.subarray(0, room).toString("utf8");
      }
      return current + chunk.toString("utf8");
    };
    child.stdout?.on("data", (c: Buffer) => {
      stdout = appendBounded(c, stdout);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = appendBounded(c, stderr);
    });

    let settle: (value: void) => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    child.on("error", () => {
      termination = "spawn-error";
      exitCode = null;
      settle!();
    });
    child.on("close", (code) => {
      if (termination === "exit") exitCode = code;
      settle!();
    });

    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    if (abortSignal) {
      onAbort = () => {
        if (termination === "exit") termination = "cancelled";
        void killProcessTree(child, "cancelled");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (termination === "exit") termination = "timeout";
      void killProcessTree(child, "timeout");
    }, timeoutMs);

    try {
      await done;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortSignal && onAbort) abortSignal.removeEventListener("abort", onAbort);
    }

    return { exitCode, termination, stdout, stderr, durationMs: Date.now() - started, truncated };
  }
}
