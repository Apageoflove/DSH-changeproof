import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { symlink, rm } from "node:fs/promises";
import { normalizeWorkspacePath, canonicalize } from "@shared/schema.js";
import { validateConfig } from "@host/config/schema.js";
import { checkCommand } from "@host/execution/command-policy.js";
import { StandaloneFsPort } from "@host/adapters/dsh/fs-port.js";
import { normalizeArtifactPath } from "@host/adapters/types.js";
import { makeTmpDir, cleanup } from "../helpers/workspace.js";

let dir: string;
let outside: string;
const fs = new StandaloneFsPort();

beforeAll(async () => {
  dir = await makeTmpDir("sec-path");
  outside = await makeTmpDir("sec-outside");
  await symlink(outside, path.join(dir, "escape-link"), "junction").catch(() => {});
});

afterAll(async () => {
  await rm(path.join(dir, "escape-link"), { force: true }).catch(() => {});
  await cleanup(dir);
  await cleanup(outside);
});

describe("workspace path normalization rejects escapes (PROJECT.md 14)", () => {
  const evil = [
    "../outside.ts",
    "..\\outside.ts",
    "a/../../outside.ts",
    "/etc/passwd",
    "E:\\Windows\\system32",
    "\\\\server\\share\\f",
    "CON",
    "com1",
    "a\0b"
  ];
  it.each(evil)("rejects %s", (p) => {
    expect(normalizeWorkspacePath(p)).toBeNull();
  });
  it("accepts plain relative paths only", () => {
    expect(normalizeWorkspacePath("src/a/b.ts")).toBe("src/a/b.ts");
    expect(normalizeWorkspacePath("./src//a/")).toBe("src/a");
  });
});

describe("config validation rejects path escapes", () => {
  const base = (root: string) => ({
    schemaVersion: 1,
    packages: [
      {
        id: "p",
        root,
        languages: ["typescript"],
        include: ["**/*.ts"],
        test: { adapter: "vitest-istanbul", argv: ["node", "x"], cwd: "", timeoutMs: 30000, coverageFile: "cov.json" }
      }
    ]
  });

  it("rejects absolute/UNC/device roots", () => {
    for (const root of ["C:\\x", "\\\\srv\\s", "/abs", "a/../b"]) {
      expect(() => validateConfig(base(root), "c")).toThrowError();
    }
  });

  it("rejects coverageFile escapes", () => {
    const cfg = base("");
    cfg.packages[0]!.test.coverageFile = "../outside/cov.json";
    expect(() => validateConfig(cfg, "c")).toThrowError();
  });

  it("rejects exclude globs containing ..", () => {
    const cfg = { ...base(""), exclude: ["../secret/**"] };
    expect(() => validateConfig(cfg as never, "c")).toThrowError();
  });
});

describe("command policy: argv-only, no shell strings", () => {
  it("rejects empty/non-string/NUL argv", () => {
    expect(() => checkCommand({ argv: [], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/argv/);
    expect(() => checkCommand({ argv: ["", "x"], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/argv/);
    expect(() => checkCommand({ argv: ["a\0b"], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/NUL/);
  });

  it("rejects argv entries with shell control operators", () => {
    expect(() => checkCommand({ argv: ["node", "-e", "x && y"], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/shell control/);
    expect(() => checkCommand({ argv: ["node", "a || b"], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/shell control/);
  });

  it("rejects cwd escapes and bad timeouts", () => {
    expect(() => checkCommand({ argv: ["node"], cwdRel: "../x", timeoutMs: 1000, expectedArtifacts: [] })).toThrowError(/escape/i);
    expect(() => checkCommand({ argv: ["node"], cwdRel: "", timeoutMs: 0, expectedArtifacts: [] })).toThrowError(/timeout/);
  });

  it("flags shells as high risk (visible to approval)", () => {
    const p = checkCommand({ argv: ["bash", "-lc", "echo hi"], cwdRel: "", timeoutMs: 1000, expectedArtifacts: [] });
    expect(p.riskLevel).toBe("high");
    expect(p.warnings.join(" ")).toMatch(/shell/);
  });
});

describe("fs port: symlink/junction jail (TOCTOU-aware)", () => {
  it("rejects artifact paths resolving outside the workspace via junction", async () => {
    await expect(fs.realpathInWorkspace(dir, "escape-link/secret.txt")).rejects.toThrowError(/escape/i);
  });

  it("accepts real in-workspace paths", async () => {
    await expect(fs.realpathInWorkspace(dir, ".")).resolves.toBeTruthy();
  });

  it("rejects lexical escapes before touching the filesystem", async () => {
    await expect(fs.realpathInWorkspace(dir, "../evil")).rejects.toThrowError();
  });
});

describe("artifact path normalization blocks poisoned keys", () => {
  it("rejects absolute, UNC and drive paths from other roots", () => {
    const ROOT = "E:/ws/repo";
    expect(normalizeArtifactPath("D:/evil/x.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("/abs/path.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("E:/evil-inside-looking/x.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("E:/ws/repo/src/ok.ts", ROOT)).toBe("src/ok.ts");
    expect(normalizeArtifactPath("../up.ts", ROOT)).toBeNull();
    expect(normalizeArtifactPath("a\\..\\..\\x.ts", ROOT)).toBeNull();
  });
});

describe("prototype pollution guard", () => {
  it("drops __proto__/constructor/prototype keys during canonicalization", () => {
    const evil = JSON.parse('{"__proto__":{"polluted":1},"ok":2}');
    const out = canonicalize(evil) as Record<string, unknown>;
    expect(out).toEqual({ ok: 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
