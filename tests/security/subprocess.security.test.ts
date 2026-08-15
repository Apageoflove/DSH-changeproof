import { describe, expect, it } from "vitest";
import path from "node:path";
import { StandaloneSubprocessPort } from "@host/adapters/dsh/subprocess-port.js";
import { buildEnv, redactArgv } from "@host/execution/command-policy.js";
import { summarizeOutput } from "@host/execution/output-limiter.js";
import { projectRoot, nodeExe } from "../helpers/workspace.js";

const port = new StandaloneSubprocessPort();
const fakeRunner = path.join(projectRoot, "fixtures", "fake-runner.mjs");

describe("subprocess security: argv, env allow-list, secrets", () => {
  it("buildEnv drops non-allowlisted variables (no secret inheritance)", () => {
    const env = buildEnv({
      PATH: "x",
      AWS_SECRET_ACCESS_KEY: "super-secret",
      GITHUB_TOKEN: "ghp_xxx",
      MY_CUSTOM_VAR: "leak?"
    });
    expect(env["PATH"]).toBe("x");
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["MY_CUSTOM_VAR"]).toBeUndefined();
  });

  it("argv redaction masks token/secret/password style values in evidence", () => {
    const redacted = redactArgv(["node", "--token", "abc123", "--password=hunter2", "ok"]);
    expect(redacted).toEqual(["node", "--token", "***", "--password=***", "ok"]);
  });

  it("rejects NUL bytes and empty argv at the port level", async () => {
    await expect(port.execute({ argv: [], cwdAbs: projectRoot, timeoutMs: 5000, maxOutputBytes: 1000, env: {} })).rejects.toThrowError(/argv/);
    await expect(port.execute({ argv: ["a\0b"], cwdAbs: projectRoot, timeoutMs: 5000, maxOutputBytes: 1000, env: {} })).rejects.toThrowError(/NUL/);
  });
});

describe("timeout kills the whole process tree (no orphans)", () => {
  it(
    "hang runner with child + grandchild is terminated within the timeout budget",
    async () => {
      const res = await port.execute({
        argv: [nodeExe, fakeRunner, "hang"],
        cwdAbs: projectRoot,
        timeoutMs: 4000,
        maxOutputBytes: 100_000,
        env: buildEnv(process.env)
      });
      expect(res.termination).toBe("timeout");
      expect(res.exitCode).not.toBe(0);
      // the fake runner prints its child/grandchild PIDs before hanging
      const match = res.stdout.match(/child=(\d+) grandchild=(\d+)/);
      expect(match).toBeTruthy();
      await new Promise((r) => setTimeout(r, 500)); // give the OS a moment
      const stillAlive = async (pid: string): Promise<boolean> => {
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          await promisify(execFile)("powershell", ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`]);
          return true;
        } catch {
          return false;
        }
      };
      expect(await stillAlive(match![1]!)).toBe(false);
      expect(await stillAlive(match![2]!)).toBe(false);
    },
    30_000
  );
});

describe("output limiter truncates with head+tail and full digest", () => {
  it("marks truncation and keeps digest of the FULL output", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n");
    const { summary, digest } = summarizeOutput(big, { maxBytes: 2000, maxLines: 100 });
    expect(summary.truncated).toBe(true);
    expect(summary.headLines.length + summary.tailLines.length).toBeLessThan(5000);
    expect(summary.headLines[0]).toBe("line-0");
    expect(summary.tailLines[summary.tailLines.length - 1]).toBe("line-4999");
    // digest covers the whole text (verifiable independently)
    const { createHash } = await import("node:crypto");
    expect(digest).toBe("sha256:" + createHash("sha256").update(big).digest("hex"));
  });
});
