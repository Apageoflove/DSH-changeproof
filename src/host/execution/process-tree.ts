/**
 * 进程树终止（PROJECT.md 8.4）。
 * Windows 用 `taskkill /T /F`；POSIX 用 detached + 负 pgid SIGKILL。
 * 总是等子进程被回收，取消/超时后保证无孤儿。
 */
import type { ChildProcess } from "node:child_process";

const TREE_KILL_GRACE_MS = 10_000;

export async function killProcessTree(child: ChildProcess, reason: "timeout" | "cancelled"): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  try {
    if (process.platform === "win32") {
      const { spawn } = await import("node:child_process");
      // /T kills the tree, /F forces. windowsHide avoids console flash.
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // process group (spawned detached)
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* best effort; the wait below still guarantees reaping */
  }
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, TREE_KILL_GRACE_MS))
  ]);
}
