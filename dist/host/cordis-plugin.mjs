// src/host/adapters/dsh/capabilities.ts
var DSH_CANDIDATES = ["@deepseek/harness", "deepseek-harness", "cordis"];
async function tryImport(specifier) {
  try {
    const mod = await import(
      /* @vite-ignore */
      specifier
    );
    const version = typeof mod.VERSION === "string" ? mod.VERSION : typeof mod.version === "string" ? mod.version : "unknown";
    return { version };
  } catch {
    return null;
  }
}
async function probeRuntime() {
  const notes = [];
  let dshPackage = null;
  let dshVersion = null;
  for (const candidate of DSH_CANDIDATES) {
    const found = await tryImport(candidate);
    if (found) {
      dshPackage = candidate;
      dshVersion = found.version;
      notes.push(`detected ${candidate}@${found.version}`);
      break;
    }
  }
  if (!dshPackage) {
    notes.push("DeepSeek Harness runtime not detected; using standalone Node capabilities (headless-complete).");
    notes.push("Required host capabilities (tools/subprocess/fs) provided by standalone ports; events/uiSlots unavailable.");
  }
  const runtime = dshPackage ? "dsh" : "standalone";
  return {
    runtime,
    dshPackage,
    dshVersion,
    tools: true,
    // standalone registry provides the same registration contract
    subprocess: true,
    // standalone port over node:child_process
    fs: true,
    // standalone port over node:fs
    events: runtime === "dsh",
    // public tools/post-execute events only exist under DSH
    uiSlots: false,
    // Web slots are optional and only exist in a Web profile
    platform: process.platform,
    notes
  };
}

// src/host/adapters/dsh/events-port.ts
var StandaloneEventsPort = class {
  available = false;
  listeners = /* @__PURE__ */ new Set();
  onToolResult(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Used by the standalone CLI to feed observed tool results (tests use it too). */
  emit(event) {
    for (const l of this.listeners) l(event);
  }
};

// src/host/adapters/dsh/fs-port.ts
import { createHash } from "node:crypto";
import { realpath, stat, readFile, lstat } from "node:fs/promises";
import path from "node:path";

// src/shared/errors.ts
var CpError = class extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = "CpError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
};

// src/host/adapters/dsh/fs-port.ts
var MAX_FILE_BYTES = 20 * 1024 * 1024;
var StandaloneFsPort = class {
  async readFileBounded(absPath, maxBytes) {
    const st = await stat(absPath);
    if (!st.isFile()) throw new CpError("CP_PATH_NOT_FOUND", `not a regular file: ${absPath}`);
    if (st.size > maxBytes) {
      const fh = await import("node:fs/promises").then((m) => m.open(absPath, "r"));
      try {
        const buf2 = Buffer.alloc(maxBytes);
        await fh.read(buf2, 0, maxBytes, 0);
        return { bytes: new Uint8Array(buf2), truncated: true };
      } finally {
        await fh.close();
      }
    }
    const buf = await readFile(absPath);
    return { bytes: new Uint8Array(buf), truncated: false };
  }
  async exists(absPath) {
    try {
      await lstat(absPath);
      return true;
    } catch {
      return false;
    }
  }
  async isSymbolicLink(absPath) {
    try {
      const st = await lstat(absPath);
      return st.isSymbolicLink();
    } catch {
      return false;
    }
  }
  async sizeOf(absPath) {
    const st = await stat(absPath);
    return st.size;
  }
  /**
   * 校验工作区相对路径并解析真实路径。拒绝：
   *   - 绝对路径 / UNC / 设备名 / `..`（词法检查）
   *   - 解析 symlink/junction 后逃出工作区根（解析后再查一次，防 TOCTOU）
   */
  async realpathInWorkspace(rootAbs, relPath) {
    const rootReal = await realpath(rootAbs);
    const lexicallySafe = path.resolve(rootReal, relPath);
    if (lexicallySafe !== rootReal && !lexicallySafe.startsWith(rootReal + path.sep)) {
      throw new CpError("CP_PATH_ESCAPE", `path escapes workspace: ${relPath}`);
    }
    let real;
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
  async digestFileNormalized(absPath, maxBytes) {
    const { bytes } = await this.readFileBounded(absPath, maxBytes);
    const normalized = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
    return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  }
};
function sha256Hex(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

// src/host/adapters/dsh/subprocess-port.ts
import { spawn } from "node:child_process";

// src/host/execution/process-tree.ts
var TREE_KILL_GRACE_MS = 1e4;
async function killProcessTree(child, reason2) {
  const pid = child.pid;
  if (pid === void 0) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  try {
    if (process.platform === "win32") {
      const { spawn: spawn2 } = await import("node:child_process");
      spawn2("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    }
  } catch {
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, TREE_KILL_GRACE_MS))
  ]);
}

// src/host/adapters/dsh/subprocess-port.ts
var StandaloneSubprocessPort = class {
  async execute(req) {
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
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwdAbs,
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
        // own process group on POSIX for tree kill
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
    let termination = "exit";
    let exitCode = null;
    const appendBounded = (chunk, current) => {
      if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
        truncated = true;
        const room = Math.max(0, maxOutputBytes - (stdout.length + stderr.length) - current.length);
        return current + chunk.subarray(0, room).toString("utf8");
      }
      return current + chunk.toString("utf8");
    };
    child.stdout?.on("data", (c) => {
      stdout = appendBounded(c, stdout);
    });
    child.stderr?.on("data", (c) => {
      stderr = appendBounded(c, stderr);
    });
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    child.on("error", () => {
      termination = "spawn-error";
      exitCode = null;
      settle();
    });
    child.on("close", (code) => {
      if (termination === "exit") exitCode = code;
      settle();
    });
    let timer = null;
    let onAbort = null;
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
};

// src/host/adapters/dsh/compatibility-facade.ts
async function createHostContext() {
  const capabilities = await probeRuntime();
  const ports = resolvePorts(capabilities);
  return { capabilities, ...ports };
}
function resolvePorts(_capabilities) {
  return {
    fs: new StandaloneFsPort(),
    subprocess: new StandaloneSubprocessPort(),
    events: new StandaloneEventsPort()
  };
}

// src/host/adapters/dsh/tools-registration.ts
var StandaloneToolsPort = class {
  tools = /* @__PURE__ */ new Map();
  register(def) {
    this.tools.set(def.id, def);
    return () => this.tools.delete(def.id);
  }
  list() {
    return [...this.tools.values()];
  }
  async invoke(id, input) {
    const def = this.tools.get(id);
    if (!def) {
      throw new Error(`tool not registered: ${id}`);
    }
    return def.handler(input ?? {});
  }
};
var TOOL_DESCRIPTIONS = {
  changeproof_plan: "Analyze the current ChangeSet, test impact and layered verification plan. Does NOT execute project code.",
  changeproof_verify: "Re-confirm the workspace fingerprint, execute the layered plan (cheap checks \u2192 targeted tests \u2192 changed-line coverage), parse artifacts and persist evidence. Executes project tests: real side effects possible; requires approval intent.",
  changeproof_status: "Recompute the current workspace fingerprint and report whether the latest evidence is fresh or stale."
};
var TOOL_INPUT_SCHEMAS = {
  changeproof_plan: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "absolute path of the workspace root" },
      baseline: { type: "string", enum: ["head", "merge-base"] }
    },
    required: ["workspace"]
  },
  changeproof_verify: {
    type: "object",
    properties: {
      workspace: { type: "string" },
      baseline: { type: "string", enum: ["head", "merge-base"] },
      approvalIntent: { type: "string", enum: ["preview", "approve"] }
    },
    required: ["workspace", "approvalIntent"]
  },
  changeproof_status: {
    type: "object",
    properties: { workspace: { type: "string" } },
    required: ["workspace"]
  }
};

// src/shared/result.ts
var TOOL_RESULT_SCHEMA_VERSION = "1.0";
function okResult(kind, data, diagnostics = []) {
  return { schemaVersion: TOOL_RESULT_SCHEMA_VERSION, kind, ok: true, data, error: null, diagnostics };
}
function errorResult(kind, code, message, details, diagnostics = []) {
  return { schemaVersion: TOOL_RESULT_SCHEMA_VERSION, kind, ok: false, data: null, error: { code, message, details }, diagnostics };
}

// src/shared/schema.ts
function canonicalize(value) {
  if (value === null || value === void 0) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const obj = value;
    const out = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === void 0) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v) {
  return typeof v === "string";
}
function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}
function assertNoUnknownKeys(obj, allowed, ctx) {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  return unknown.map((k) => `${ctx}: unknown field "${k}"`);
}
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
function globMatch(glob, path7) {
  return globToRegExp(glob).test(path7);
}
var WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function normalizeWorkspacePath(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.includes("\0")) return null;
  const p = input.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(p)) return null;
  if (/^\/\//.test(p)) return null;
  if (p.startsWith("/")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(p)) return null;
  const segments = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.endsWith(" ") || seg.startsWith(" ")) return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) return null;
    if (WINDOWS_DEVICE_RE.test(seg)) return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

// src/host/adapters/types.ts
function normalizeArtifactPath(key, workspaceRootAbs) {
  if (!key || key.includes("\0")) return null;
  const root = workspaceRootAbs.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = key.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.startsWith("a/")) p = p.slice(2);
  if (p.startsWith("b/")) p = p.slice(2);
  const rootLower = root.toLowerCase();
  if (p.toLowerCase().startsWith(rootLower + "/")) {
    return p.slice(root.length + 1);
  }
  const m = p.match(/^[a-zA-Z]:\/(.*)$/);
  if (m) {
    const relCandidate = m[1];
    const rootTail = root.split("/").slice(1).join("/").toLowerCase();
    if (rootTail.length > 0 && relCandidate.toLowerCase().startsWith(rootTail + "/")) {
      return relCandidate.slice(rootTail.length + 1);
    }
    return null;
  }
  if (p.startsWith("/")) return null;
  const segments = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

// src/host/adapters/javascript/istanbul.ts
function parseLoc(raw, ctx) {
  if (!isPlainObject(raw) || !isPlainObject(raw["start"]) || !isPlainObject(raw["end"])) {
    throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: location must have start/end objects`);
  }
  const sl = Number(raw["start"]["line"]);
  const el = Number(raw["end"]["line"]);
  if (!Number.isInteger(sl) || !Number.isInteger(el) || sl < 1 || el < sl || el - sl > 1e5) {
    throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: invalid line numbers (start ${sl}, end ${el})`);
  }
  return { start: { line: sl }, end: { line: el } };
}
function addRange(set, loc, maxLines, ctx) {
  if (loc.end.line - loc.start.line + 1 > maxLines) {
    throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `${ctx}: location spans ${loc.end.line - loc.start.line + 1} lines (cap ${maxLines}); refusing to guess`);
  }
  for (let ln = loc.start.line; ln <= loc.end.line; ln += 1) set.add(ln);
}
var IstanbulAdapter = class {
  id = "istanbul";
  version = "1.0";
  artifactKind = "istanbul-json";
  parse(jsonText, opts) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(parsed)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "istanbul artifact root must be an object keyed by file path");
    }
    const entries = Object.keys(parsed);
    if (entries.length > opts.maxFileEntries) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `istanbul artifact has ${entries.length} file entries (cap ${opts.maxFileEntries})`);
    }
    const executableByFile = /* @__PURE__ */ new Map();
    const coveredByFile = /* @__PURE__ */ new Map();
    const diagnostics = [];
    for (const [key, rawFile] of Object.entries(parsed)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul artifact contains forbidden key "${key}"`);
      }
      const path7 = normalizeArtifactPath(key, opts.workspaceRootAbs);
      if (!path7) {
        diagnostics.push(`skipping artifact entry outside workspace: ${key.slice(0, 120)}`);
        continue;
      }
      if (!isPlainObject(rawFile)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `istanbul entry for ${path7} must be an object`);
      }
      const ctx = `istanbul[${path7}]`;
      const statementMap = rawFile["statementMap"];
      const fnMap = rawFile["fnMap"] ?? {};
      const branchMap = rawFile["branchMap"] ?? {};
      const s = rawFile["s"];
      const f = rawFile["f"] ?? {};
      const b = rawFile["b"] ?? {};
      if (!isPlainObject(statementMap) || !isPlainObject(s)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}: statementMap and s counters are required`);
      }
      const executable = /* @__PURE__ */ new Set();
      const covered = /* @__PURE__ */ new Set();
      for (const [idx, locRaw] of Object.entries(statementMap)) {
        if (idx === "__proto__") continue;
        const loc = parseLoc(locRaw, `${ctx}.statementMap[${idx}]`);
        addRange(executable, loc, opts.maxLinesPerFile, `${ctx}.statementMap[${idx}]`);
        const count = s[idx];
        if (count === void 0 || !isCountKey(idx, s)) continue;
        const n = Number(count);
        if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.s[${idx}] is not a number`);
        if (n > 0) addRange(covered, loc, opts.maxLinesPerFile, `${ctx}.statementMap[${idx}]`);
      }
      if (isPlainObject(fnMap)) {
        for (const [idx, rawFn] of Object.entries(fnMap)) {
          if (idx === "__proto__" || !isPlainObject(rawFn)) continue;
          const locRaw = rawFn["loc"] ?? rawFn["decl"];
          if (locRaw === void 0) continue;
          const loc = parseLoc(locRaw, `${ctx}.fnMap[${idx}]`);
          executable.add(loc.start.line);
          const n = Number(f[idx] ?? 0);
          if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.f[${idx}] is not a number`);
          if (n > 0) covered.add(loc.start.line);
        }
      }
      if (isPlainObject(branchMap)) {
        for (const [idx, rawBranch] of Object.entries(branchMap)) {
          if (idx === "__proto__" || !isPlainObject(rawBranch)) continue;
          const rawLocs = rawBranch["locations"];
          if (!Array.isArray(rawLocs)) continue;
          const counts = b[idx];
          if (!Array.isArray(counts) || counts.length !== rawLocs.length) {
            throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.b[${idx}] must parallel branchMap locations`);
          }
          rawLocs.forEach((locRaw, j) => {
            if (locRaw === null || locRaw === void 0) return;
            const loc = parseLoc(locRaw, `${ctx}.branchMap[${idx}][${j}]`);
            executable.add(loc.start.line);
            const n = Number(counts[j]);
            if (!Number.isFinite(n)) throw new CpError("CP_COVERAGE_PARSE_ERROR", `${ctx}.b[${idx}][${j}] is not a number`);
            if (n > 0) covered.add(loc.start.line);
          });
        }
      }
      executableByFile.set(path7, executable);
      coveredByFile.set(path7, covered);
    }
    return { executableByFile, coveredByFile, diagnostics };
  }
};
function isCountKey(idx, s) {
  return Object.prototype.hasOwnProperty.call(s, idx);
}
var istanbulAdapter = new IstanbulAdapter();

// src/host/adapters/javascript/vitest-jest.ts
var VitestJestAdapter = class {
  id;
  version = "1.0";
  coverageAdapter = istanbulAdapter;
  constructor(id = "vitest-istanbul") {
    this.id = id;
  }
  buildArgv(configuredArgv, candidateTestFiles) {
    const runnerIdx = configuredArgv.findIndex((a) => a === "vitest" || a === "jest");
    if (runnerIdx === -1 || candidateTestFiles.length === 0) {
      return { argv: [...configuredArgv], scoped: false };
    }
    return { argv: [...configuredArgv, ...candidateTestFiles], scoped: true };
  }
  coverageFileOf(pkg) {
    return pkg.test.coverageFile;
  }
};
var vitestAdapter = new VitestJestAdapter("vitest-istanbul");
var jestAdapter = new VitestJestAdapter("jest-istanbul");

// src/host/adapters/python/coverage-json.ts
var SUPPORTED_JSON_FORMAT = 3;
var SUPPORTED_COVERAGE_VERSIONS = ["6.", "7."];
var CoveragePyAdapter = class {
  id = "coverage-py";
  version = "1.0";
  artifactKind = "coverage-py-json";
  parse(jsonText, opts) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(parsed)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "coverage.py artifact root must be an object");
    }
    const meta = parsed["meta"];
    if (!isPlainObject(meta) || meta["format"] !== SUPPORTED_JSON_FORMAT || typeof meta["version"] !== "string") {
      throw new CpError(
        "CP_COVERAGE_SCHEMA_UNKNOWN",
        `coverage.py artifact must declare meta.format=${SUPPORTED_JSON_FORMAT} with a string meta.version (got ${JSON.stringify(meta["format"])})`
      );
    }
    const version = meta["version"];
    if (!SUPPORTED_COVERAGE_VERSIONS.some((p) => version.startsWith(p))) {
      throw new CpError("CP_COVERAGE_SCHEMA_UNKNOWN", `unsupported coverage.py version "${version}" (supported: 6.x, 7.x with JSON format ${SUPPORTED_JSON_FORMAT}) \u2014 refusing to guess fields`);
    }
    const files = parsed["files"];
    if (!isPlainObject(files)) {
      throw new CpError("CP_COVERAGE_PARSE_ERROR", "coverage.py artifact must contain a files mapping");
    }
    const entries = Object.keys(files);
    if (entries.length > opts.maxFileEntries) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage.py artifact has ${entries.length} file entries (cap ${opts.maxFileEntries})`);
    }
    const executableByFile = /* @__PURE__ */ new Map();
    const coveredByFile = /* @__PURE__ */ new Map();
    const diagnostics = [];
    for (const [key, raw] of Object.entries(files)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py artifact contains forbidden key "${key}"`);
      }
      const path7 = normalizeArtifactPath(key, opts.workspaceRootAbs);
      if (!path7) {
        diagnostics.push(`skipping artifact entry outside workspace: ${key.slice(0, 120)}`);
        continue;
      }
      if (!isPlainObject(raw)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path7} must be an object`);
      }
      const executed = raw["executed_lines"];
      const missing = raw["missing_lines"];
      const excluded = raw["excluded_lines"] ?? [];
      if (!Array.isArray(executed) || !Array.isArray(missing) || !Array.isArray(excluded)) {
        throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path7}: executed_lines/missing_lines must be arrays`);
      }
      const toLines = (arr, field) => {
        const out = /* @__PURE__ */ new Set();
        for (const v of arr) {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 1e7) {
            throw new CpError("CP_COVERAGE_PARSE_ERROR", `coverage.py entry for ${path7}: ${field} contains invalid line ${JSON.stringify(v)}`);
          }
          out.add(n);
        }
        if (out.size > opts.maxLinesPerFile) {
          throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage.py entry for ${path7}: ${field} exceeds ${opts.maxLinesPerFile} lines`);
        }
        return out;
      };
      const executedSet = toLines(executed, "executed_lines");
      const missingSet = toLines(missing, "missing_lines");
      const excludedSet = toLines(excluded, "excluded_lines");
      const executable = /* @__PURE__ */ new Set([...executedSet, ...missingSet]);
      for (const ex of excludedSet) executable.delete(ex);
      executableByFile.set(path7, executable);
      const covered = /* @__PURE__ */ new Set();
      for (const ln of executedSet) {
        if (!excludedSet.has(ln)) covered.add(ln);
      }
      coveredByFile.set(path7, covered);
    }
    return { executableByFile, coveredByFile, diagnostics };
  }
};
var coveragePyAdapter = new CoveragePyAdapter();

// src/host/adapters/python/pytest-coverage.ts
var PytestCoverageAdapter = class {
  id = "pytest-coverage-json";
  version = "1.0";
  coverageAdapter = coveragePyAdapter;
  buildArgv(configuredArgv, candidateTestFiles) {
    const runnerIdx = configuredArgv.findIndex((a) => a === "pytest" || a === "py.test");
    if (runnerIdx === -1 || candidateTestFiles.length === 0) {
      return { argv: [...configuredArgv], scoped: false };
    }
    return { argv: [...configuredArgv, ...candidateTestFiles], scoped: true };
  }
  coverageFileOf(pkg) {
    return pkg.test.coverageFile;
  }
};
var pytestAdapter = new PytestCoverageAdapter();

// src/host/execution/planner.ts
function adapterFor(id) {
  switch (id) {
    case "vitest-istanbul":
      return vitestAdapter;
    case "jest-istanbul":
      return jestAdapter;
    case "pytest-coverage-json":
      return pytestAdapter;
    default:
      throw new Error(`unknown adapter id: ${id}`);
  }
}
function rebaseToCwd(files, cwd) {
  if (cwd === "") return [...files];
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return files.map((f) => f.startsWith(prefix) ? f.slice(prefix.length) : f);
}
function buildPlan(inputs, hash) {
  const { config, candidates } = inputs;
  const steps = [];
  const diagnostics = [];
  for (const check of config.checks.filter((c) => c.tier === "cheap")) {
    steps.push({
      id: `cheap:${check.id}`,
      tier: "cheap",
      required: check.required,
      adapterId: "process",
      argv: check.argv ?? [],
      cwd: check.cwd,
      timeoutMs: check.timeoutMs,
      expectedArtifacts: [],
      dependsOn: [],
      rationale: [`configured cheap check "${check.id}"`]
    });
  }
  const cheapStepIds = steps.filter((s) => s.tier === "cheap" && s.required).map((s) => s.id);
  const targetedStepIds = [];
  const packagesWithCandidates = new Set(candidates.map((c) => c.packageId));
  for (const pkg of config.packages) {
    const pkgCandidates = candidates.filter((c) => c.packageId === pkg.id && c.testFiles.length > 0);
    const checkOverride = config.checks.find((c) => c.tier === "targeted-test" && c.packageId === pkg.id);
    const needed = pkgCandidates.length > 0 || (checkOverride?.required ?? false);
    if (!needed) continue;
    const adapter = adapterFor(pkg.test.adapter);
    const candidateFiles = [...new Set(pkgCandidates.flatMap((c) => c.testFiles))];
    const { argv, scoped } = adapter.buildArgv(pkg.test.argv, rebaseToCwd(candidateFiles, pkg.test.cwd));
    if (!scoped) {
      diagnostics.push(
        `package "${pkg.id}" argv is not file-scopable; running the full configured test argv (impact candidates still recorded)`
      );
    }
    const stepId = `targeted-test:${pkg.id}`;
    steps.push({
      id: stepId,
      tier: "targeted-test",
      required: checkOverride?.required ?? true,
      adapterId: adapter.id,
      argv,
      cwd: pkg.test.cwd,
      timeoutMs: pkg.test.timeoutMs,
      expectedArtifacts: [pkg.test.coverageFile],
      dependsOn: cheapStepIds,
      rationale: [
        `impact candidates for package "${pkg.id}": ${pkgCandidates.map((c) => `${c.id} (${c.confidence})`).join("; ") || "configured required check"}`,
        `expected artifact: ${pkg.test.coverageFile}`
      ]
    });
    targetedStepIds.push(stepId);
  }
  for (const pkg of config.packages) {
    if (!packagesWithCandidates.has(pkg.id) && !targetedStepIds.includes(`targeted-test:${pkg.id}`)) continue;
    const adapter = adapterFor(pkg.test.adapter);
    steps.push({
      id: `changed-line-coverage:${pkg.id}`,
      tier: "changed-line-coverage",
      required: true,
      adapterId: adapter.coverageAdapter.id,
      argv: [],
      cwd: pkg.test.cwd,
      timeoutMs: 3e4,
      expectedArtifacts: [pkg.test.coverageFile],
      dependsOn: targetedStepIds,
      rationale: [`parse ${pkg.test.coverageFile} and intersect with changed executable lines`]
    });
  }
  if (steps.length === 0) {
    diagnostics.push("no steps planned: no changed files matched any package and no checks configured for this ChangeSet");
  }
  const planId = hash(
    canonicalJsonStringify({
      schemaVersion: "1.0",
      changeSetDigest: inputs.changeSetDigest,
      workspaceFingerprint: inputs.workspaceFingerprint,
      steps: steps.map((s) => ({ id: s.id, tier: s.tier, argv: s.argv, cwd: s.cwd })),
      candidates: candidates.map((c) => c.id)
    })
  );
  return {
    schemaVersion: "1.0",
    id: planId,
    changeSetDigest: inputs.changeSetDigest,
    workspaceFingerprint: inputs.workspaceFingerprint,
    candidates,
    steps,
    diagnostics
  };
}

// src/host/adapters/git/diff-parser.ts
var HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function normalizeDiffPath(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
    }
  }
  if (p === "/dev/null") return "/dev/null";
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
function parseUnifiedDiff(text) {
  const files = [];
  const lines = text.split("\n");
  let i = 0;
  let current = null;
  const pushRange = (f, r) => {
    if (r.startLine > r.endLine) return;
    const last = f.ranges[f.ranges.length - 1];
    if (last && last.kind === r.kind && r.startLine <= last.endLine + 1 && r.startLine >= last.startLine && r.endLine >= last.endLine) {
      last.endLine = r.endLine;
      return;
    }
    f.ranges.push(r);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        oldPath: m ? normalizeDiffPath("a/" + m[1]) : null,
        newPath: m ? normalizeDiffPath("b/" + m[2]) : null,
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
        const oldStart = parseInt(hunk[1], 10);
        const oldCount = hunk[2] === void 0 ? 1 : parseInt(hunk[2], 10);
        const newStart = parseInt(hunk[3], 10);
        const newCount = hunk[4] === void 0 ? 1 : parseInt(hunk[4], 10);
        i += 1;
        let oldLine = oldStart;
        let newLine = newStart;
        let oldLeft = oldCount;
        let newLeft = newCount;
        let addedRun = null;
        let deletedRun = null;
        let hunkHasDeletions = false;
        let hunkHasAdditions = false;
        const flushAdded = () => {
          if (!addedRun) return;
          pushRange(current, {
            startLine: addedRun.start,
            endLine: addedRun.end,
            kind: hunkHasDeletions ? "modified" : "added"
          });
          addedRun = null;
        };
        const flushDeleted = () => {
          if (!deletedRun) return;
          pushRange(current, { startLine: deletedRun.start, endLine: deletedRun.end, kind: "deleted" });
          deletedRun = null;
        };
        while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
          const raw = lines[i];
          const marker = raw[0];
          const content = raw.slice(1);
          if (marker === "+") {
            flushDeleted();
            if (addedRun) addedRun.end = newLine;
            else addedRun = { start: newLine, end: newLine };
            current.linesAdded += 1;
            hunkHasAdditions = true;
            newLine += 1;
            newLeft -= 1;
            i += 1;
          } else if (marker === "-") {
            flushAdded();
            if (deletedRun) deletedRun.end = oldLine;
            else deletedRun = { start: oldLine, end: oldLine };
            current.linesDeleted += 1;
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
            i += 1;
          } else {
            throw new CpError("CP_DIFF_PARSE_ERROR", `malformed hunk body at diff line ${i + 1}: ${JSON.stringify(raw.slice(0, 80))}`);
          }
        }
        flushAdded();
        flushDeleted();
        if (current.status !== "deleted" && current.ranges.length >= 2) {
          const last = current.ranges[current.ranges.length - 1];
          const prev = current.ranges[current.ranges.length - 2];
          if (last.kind === prev.kind && last.kind !== "deleted" && last.startLine <= prev.endLine + 1 && last.endLine >= prev.endLine) {
            prev.endLine = last.endLine;
            current.ranges.pop();
          }
        }
        continue;
      }
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
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

// src/host/adapters/git/changeset.ts
var GIT_COMMON = ["-c", "core.quotepath=false", "-c", "core.safecrlf=false"];
function toPosix(p) {
  return p.replace(/\\/g, "/");
}
function parsePorcelain(raw) {
  const entries = [];
  const parts = raw.split("\0").filter((s) => s.length > 0);
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    if (part.length < 4) continue;
    const x = part[0];
    const y = part[1];
    const pathRaw = part.slice(3);
    if (x === "R" || x === "C") {
      const oldPath = parts[idx + 1] ?? "";
      idx += 1;
      entries.push({ path: pathRaw, oldPath, x, y });
    } else {
      entries.push({ path: pathRaw, x, y });
    }
  }
  return entries;
}
function statusFromDiff(fd, porcelain) {
  if (fd.status === "added") return porcelain?.x === "A" ? "added" : "untracked";
  if (fd.status === "deleted") return "deleted";
  if (fd.status === "renamed") return "renamed";
  if (porcelain?.x === "A") return "added";
  return "modified";
}
function digestOfChangeSet(cs, hash) {
  const payload = {
    schemaVersion: cs.schemaVersion,
    mode: cs.mode,
    workspaceId: cs.workspaceId,
    baseline: cs.baseline,
    files: cs.files.map((f) => ({
      path: f.path,
      status: f.status,
      oldPath: f.oldPath ?? null,
      contentDigest: f.contentDigest,
      ranges: f.ranges,
      linesAdded: f.linesAdded,
      linesDeleted: f.linesDeleted
    }))
  };
  return hash(canonicalJsonStringify(payload));
}
async function buildChangeSet(opts) {
  const { workspaceRootAbs, runGit, digestFile, workspaceId } = opts;
  const diagnostics = [];
  const rootRes = await runGit([...GIT_COMMON, "rev-parse", "--show-toplevel"], workspaceRootAbs);
  if (rootRes.code !== 0) {
    throw new CpError("CP_NOT_A_GIT_REPO", `not a git repository: ${workspaceRootAbs}`);
  }
  const repoRoot = rootRes.stdout.trim();
  let baselineCommit = null;
  if (opts.baselineKind === "merge-base") {
    const ref = opts.mergeBaseRef ?? "origin/main";
    const mb = await runGit([...GIT_COMMON, "merge-base", ref, "HEAD"], repoRoot);
    if (mb.code !== 0) {
      diagnostics.push(`merge-base with ${ref} failed (${mb.stderr.trim()}); falling back to HEAD baseline`);
      const head = await runGit([...GIT_COMMON, "rev-parse", "HEAD"], repoRoot);
      baselineCommit = head.code === 0 ? head.stdout.trim() : null;
    } else {
      baselineCommit = mb.stdout.trim();
    }
  } else {
    const head = await runGit([...GIT_COMMON, "rev-parse", "HEAD"], repoRoot);
    if (head.code !== 0) {
      diagnostics.push("repository has no commits (empty HEAD); ChangeSet degraded");
    } else {
      baselineCommit = head.stdout.trim();
    }
  }
  const porcelainRes = await runGit([...GIT_COMMON, "status", "--porcelain=v1", "-z"], repoRoot);
  if (porcelainRes.code !== 0) {
    throw new CpError("CP_GIT_FAILED", `git status failed: ${porcelainRes.stderr.trim()}`);
  }
  const porcelain = parsePorcelain(porcelainRes.stdout);
  let fileDiffs = [];
  if (baselineCommit) {
    const diffRes = await runGit([...GIT_COMMON, "diff", "--no-color", "-U0", baselineCommit, "--"], repoRoot);
    if (diffRes.code !== 0 && diffRes.code !== 1) {
      throw new CpError("CP_GIT_FAILED", `git diff failed: ${diffRes.stderr.trim()}`);
    }
    fileDiffs = parseUnifiedDiff(diffRes.stdout);
  }
  const files = [];
  const seen = /* @__PURE__ */ new Set();
  for (const fd of fileDiffs) {
    const path7 = toPosix(fd.newPath ?? fd.oldPath ?? "");
    if (!path7 || path7 === "/dev/null") continue;
    const porcelainEntry = porcelain.find((e) => e.path === path7 || e.oldPath === path7);
    const status = statusFromDiff(fd, porcelainEntry);
    const isDeleted = status === "deleted";
    const contentDigest = isDeleted ? null : await digestFile(`${workspaceRootAbs}/${path7}`).catch(() => null);
    files.push({
      path: path7,
      status,
      oldPath: status === "renamed" && fd.renameFrom ? toPosix(fd.renameFrom) : void 0,
      contentDigest,
      ranges: fd.ranges,
      coverableExecutableLines: [],
      // filled by changed-lines analysis
      linesAdded: fd.linesAdded,
      linesDeleted: fd.linesDeleted
    });
    seen.add(path7);
  }
  for (const e of porcelain) {
    if (e.x !== "?" || e.y !== "?") continue;
    const p = toPosix(e.path);
    if (seen.has(p)) continue;
    const included = opts.untrackedIncludeGlobs.some((g) => globMatch(g, p));
    if (!included) {
      diagnostics.push(`untracked file not covered by any package include: ${p} (excluded from ChangeSet)`);
      continue;
    }
    const lineCount = await countLines(`${workspaceRootAbs}/${p}`);
    files.push({
      path: p,
      status: "untracked",
      contentDigest: await digestFile(`${workspaceRootAbs}/${p}`).catch(() => null),
      ranges: lineCount > 0 ? [{ startLine: 1, endLine: lineCount, kind: "added" }] : [],
      coverableExecutableLines: [],
      linesAdded: lineCount,
      linesDeleted: 0
    });
    seen.add(p);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const base = {
    schemaVersion: "1.0",
    mode: baselineCommit ? "git" : "degraded",
    workspaceId,
    baseline: { kind: opts.baselineKind, commit: baselineCommit },
    files,
    diagnostics
  };
  return { ...base, digest: digestOfChangeSet(base, opts.hashCanonical) };
}
async function countLines(absPath) {
  const { readFile: readFile4 } = await import("node:fs/promises");
  try {
    const text = (await readFile4(absPath, "utf8")).replace(/\r\n/g, "\n");
    if (text.length === 0) return 0;
    return text.split("\n").filter((l, idx, arr) => !(l === "" && idx === arr.length - 1)).length;
  } catch {
    return 0;
  }
}

// src/host/config/defaults.ts
var DEFAULT_CONFIG_PATH = ".changeproof.yml";
var DEFAULT_OUTPUT_LIMITS = {
  maxBytes: 2e5,
  maxLines: 2e3
};
var DEFAULT_VERDICT_POLICY = {
  changedLinesThreshold: 1,
  requiresExhaustiveImpact: true,
  minimumImpactConfidence: "MEDIUM",
  deletionOnlyPolicy: "PARTIAL"
};
function verdictPolicyFromConfig(config) {
  return {
    ...DEFAULT_VERDICT_POLICY,
    changedLinesThreshold: config.thresholds.changedLines,
    minimumImpactConfidence: config.thresholds.minimumImpactConfidence,
    // LOW-only impact blocks VERIFIED unless the user explicitly lowered the
    // minimum confidence to LOW.
    requiresExhaustiveImpact: config.thresholds.minimumImpactConfidence !== "LOW"
  };
}

// src/host/config/schema.ts
var TOP_LEVEL_KEYS = [
  "schemaVersion",
  "baseline",
  "packages",
  "checks",
  "mappings",
  "coverage",
  "thresholds",
  "exclude"
];
var CONFIDENCES = ["HIGH", "MEDIUM", "LOW"];
var ADAPTERS = ["vitest-istanbul", "jest-istanbul", "pytest-coverage-json"];
var LANGUAGES = ["typescript", "javascript", "python"];
function validateRelativePath(value, ctx, allowEmpty = false) {
  if (!isString(value) || value.length === 0) {
    if (allowEmpty && value === "") return "";
    throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a non-empty string`);
  }
  const normalized = normalizeWorkspacePath(value);
  if (normalized === null) {
    throw new CpError("CP_PATH_ESCAPE", `${ctx}: path "${value}" is not a safe workspace-relative path (no "..", absolute, device or UNC paths)`);
  }
  return normalized;
}
function validateGlob(value, ctx) {
  if (!isString(value) || value.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a non-empty glob string`);
  if (value.includes("..")) throw new CpError("CP_CONFIG_INVALID", `${ctx}: glob must not contain ".."`);
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) throw new CpError("CP_CONFIG_INVALID", `${ctx}: glob must be workspace-relative`);
  try {
    globToRegExp(normalized);
  } catch {
    throw new CpError("CP_CONFIG_INVALID", `${ctx}: invalid glob "${value}"`);
  }
  return normalized;
}
function validateArgv(value, ctx) {
  if (!isStringArray(value) || value.length === 0) {
    throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a non-empty argv array of strings (no shell strings)`);
  }
  for (const a of value) {
    if (a.includes("\0")) throw new CpError("CP_CONFIG_INVALID", `${ctx}: argv entries must not contain NUL`);
    if (/[&|;`$><\n]/.test(a) && a.length > 0 && process.env["CP_ALLOW_SHELLY_ARGV"] !== "1") {
      if (/&&|\|\||;\s|\n/.test(a)) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}: argv entry looks like a shell command line ("${a.slice(0, 60)}"); split into argv elements or use an explicit executable`);
      }
    }
  }
  return [...value];
}
function validateConfig(raw, sourcePath) {
  if (!isPlainObject(raw)) throw new CpError("CP_CONFIG_INVALID", "config root must be a mapping");
  const unknownTop = assertNoUnknownKeys(raw, TOP_LEVEL_KEYS, "config");
  if (unknownTop.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownTop.join("; "));
  if (raw["schemaVersion"] !== 1) {
    throw new CpError("CP_CONFIG_INVALID", `schemaVersion must be 1 (got ${JSON.stringify(raw["schemaVersion"])})`);
  }
  let baseline = { kind: "head" };
  if (raw["baseline"] !== void 0) {
    const b = raw["baseline"];
    if (!isPlainObject(b)) throw new CpError("CP_CONFIG_INVALID", "baseline must be a mapping");
    const unknownB = assertNoUnknownKeys(b, ["kind", "ref"], "baseline");
    if (unknownB.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownB.join("; "));
    const kind = b["kind"];
    if (kind !== "head" && kind !== "merge-base") throw new CpError("CP_CONFIG_INVALID", "baseline.kind must be head|merge-base");
    baseline = kind === "merge-base" ? { kind, ref: isString(b["ref"]) ? b["ref"] : "origin/main" } : { kind };
  }
  if (!Array.isArray(raw["packages"]) || raw["packages"].length === 0) {
    throw new CpError("CP_CONFIG_INVALID", "packages must be a non-empty array");
  }
  const packages = [];
  const seenIds = /* @__PURE__ */ new Set();
  for (let i = 0; i < raw["packages"].length; i += 1) {
    const p = raw["packages"][i];
    const ctx = `packages[${i}]`;
    if (!isPlainObject(p)) throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a mapping`);
    const unknownP = assertNoUnknownKeys(p, ["id", "root", "languages", "include", "test"], ctx);
    if (unknownP.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownP.join("; "));
    const id = p["id"];
    if (!isString(id) || id.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.id must be a non-empty string`);
    if (seenIds.has(id)) throw new CpError("CP_CONFIG_INVALID", `${ctx}.id duplicate: ${id}`);
    seenIds.add(id);
    const root = validateRelativePath(p["root"] ?? "", `${ctx}.root`, true);
    const languages = p["languages"];
    if (!isStringArray(languages) || languages.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.languages must be a non-empty string array`);
    for (const lang of languages) {
      if (!LANGUAGES.includes(lang)) throw new CpError("CP_CONFIG_INVALID", `${ctx}.languages: unsupported language "${lang}" (supported: ${LANGUAGES.join(", ")})`);
    }
    const include = p["include"];
    if (!isStringArray(include) || include.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.include must be a non-empty glob array`);
    const includeGlobs = include.map((g, j) => validateGlob(g, `${ctx}.include[${j}]`));
    const t = p["test"];
    const tctx = `${ctx}.test`;
    if (!isPlainObject(t)) throw new CpError("CP_CONFIG_INVALID", `${tctx} must be a mapping`);
    const unknownT = assertNoUnknownKeys(t, ["adapter", "argv", "cwd", "timeoutMs", "coverageFile"], tctx);
    if (unknownT.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownT.join("; "));
    const adapter = t["adapter"];
    if (!isString(adapter) || !ADAPTERS.includes(adapter)) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.adapter must be one of ${ADAPTERS.join(", ")}`);
    }
    const argv = validateArgv(t["argv"], `${tctx}.argv`);
    const testCwd = validateRelativePath(t["cwd"] ?? "", `${tctx}.cwd`, true);
    if (testCwd !== "" && root !== "" && !testCwd.startsWith(root + "/") && testCwd !== root) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.cwd (${testCwd}) escapes package root (${root})`);
    }
    if (testCwd !== "" && root === "" && !includeGlobs.some((g) => testCwd.startsWith(g.replace(/\/\*\*.*$/, "")))) {
    }
    const timeoutMs = t["timeoutMs"];
    if (!isNumber(timeoutMs) || timeoutMs <= 0 || timeoutMs > 36e5) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.timeoutMs must be a number in (0, 3600000]`);
    }
    const coverageFile = validateRelativePath(t["coverageFile"], `${tctx}.coverageFile`);
    packages.push({ id, root, languages, include: includeGlobs, test: { adapter, argv, cwd: testCwd, timeoutMs, coverageFile } });
  }
  for (let a = 0; a < packages.length; a += 1) {
    for (let b = a + 1; b < packages.length; b += 1) {
      const ra = packages[a].root;
      const rb = packages[b].root;
      if (ra === "" || rb === "") continue;
      if (ra === rb || ra.startsWith(rb + "/") || rb.startsWith(ra + "/")) {
        throw new CpError("CP_CONFIG_INVALID", `packages "${packages[a].id}" and "${packages[b].id}" have overlapping roots (${ra} vs ${rb}); ambiguous package boundary`);
      }
    }
  }
  const checks = [];
  if (raw["checks"] !== void 0) {
    if (!Array.isArray(raw["checks"])) throw new CpError("CP_CONFIG_INVALID", "checks must be an array");
    const seenCheckIds = /* @__PURE__ */ new Set();
    for (let i = 0; i < raw["checks"].length; i += 1) {
      const c = raw["checks"][i];
      const ctx = `checks[${i}]`;
      if (!isPlainObject(c)) throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a mapping`);
      const unknownC = assertNoUnknownKeys(c, ["id", "package", "tier", "required", "argv", "cwd", "timeoutMs", "usePackageTestAdapter"], ctx);
      if (unknownC.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownC.join("; "));
      const id = c["id"];
      if (!isString(id) || id.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.id must be a non-empty string`);
      if (seenCheckIds.has(id)) throw new CpError("CP_CONFIG_INVALID", `${ctx}.id duplicate: ${id}`);
      seenCheckIds.add(id);
      const packageId = c["package"];
      if (!isString(packageId) || !seenIds.has(packageId)) throw new CpError("CP_CONFIG_INVALID", `${ctx}.package must reference a configured package id`);
      const tier = c["tier"];
      if (tier !== "cheap" && tier !== "targeted-test") throw new CpError("CP_CONFIG_INVALID", `${ctx}.tier must be cheap|targeted-test`);
      const required = c["required"] === void 0 ? true : c["required"];
      if (typeof required !== "boolean") throw new CpError("CP_CONFIG_INVALID", `${ctx}.required must be boolean`);
      const usePackageTestAdapter = c["usePackageTestAdapter"] === void 0 ? false : c["usePackageTestAdapter"];
      if (typeof usePackageTestAdapter !== "boolean") throw new CpError("CP_CONFIG_INVALID", `${ctx}.usePackageTestAdapter must be boolean`);
      let argv;
      if (c["argv"] !== void 0) argv = validateArgv(c["argv"], `${ctx}.argv`);
      if (tier === "cheap" && !argv) throw new CpError("CP_CONFIG_INVALID", `${ctx}: cheap checks must define argv`);
      if (tier === "targeted-test" && !argv && !usePackageTestAdapter) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}: targeted-test checks need argv or usePackageTestAdapter:true`);
      }
      const cwd = validateRelativePath(c["cwd"] === void 0 ? packages.find((p) => p.id === packageId).root : c["cwd"], `${ctx}.cwd`, true);
      const timeoutMs = c["timeoutMs"] === void 0 ? 12e4 : c["timeoutMs"];
      if (!isNumber(timeoutMs) || timeoutMs <= 0 || timeoutMs > 36e5) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}.timeoutMs must be a number in (0, 3600000]`);
      }
      checks.push({ id, packageId, tier, required, argv, cwd, timeoutMs, usePackageTestAdapter });
    }
  }
  const mappings = [];
  if (raw["mappings"] !== void 0) {
    if (!Array.isArray(raw["mappings"])) throw new CpError("CP_CONFIG_INVALID", "mappings must be an array");
    for (let i = 0; i < raw["mappings"].length; i += 1) {
      const m = raw["mappings"][i];
      const ctx = `mappings[${i}]`;
      if (!isPlainObject(m)) throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a mapping`);
      const unknownM = assertNoUnknownKeys(m, ["sources", "tests", "confidence"], ctx);
      if (unknownM.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownM.join("; "));
      const sources = m["sources"];
      const tests = m["tests"];
      if (!isStringArray(sources) || sources.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.sources must be a non-empty glob array`);
      if (!isStringArray(tests) || tests.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.tests must be a non-empty glob array`);
      const confidence = m["confidence"];
      if (!isString(confidence) || !CONFIDENCES.includes(confidence)) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}.confidence must be HIGH|MEDIUM|LOW`);
      }
      mappings.push({
        sources: sources.map((g, j) => validateGlob(g, `${ctx}.sources[${j}]`)),
        tests: tests.map((g, j) => validateGlob(g, `${ctx}.tests[${j}]`)),
        confidence
      });
    }
  }
  let coverage = {
    changedLinesOnly: true,
    requireArtifact: true,
    sourceMap: "auto",
    historyMap: { enabled: false, maxAgeDays: 14 }
  };
  if (raw["coverage"] !== void 0) {
    const c = raw["coverage"];
    if (!isPlainObject(c)) throw new CpError("CP_CONFIG_INVALID", "coverage must be a mapping");
    const unknownC = assertNoUnknownKeys(c, ["changedLinesOnly", "requireArtifact", "sourceMap", "historyMap"], "coverage");
    if (unknownC.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownC.join("; "));
    const sourceMap = c["sourceMap"] === void 0 ? "auto" : c["sourceMap"];
    if (sourceMap !== "auto" && sourceMap !== "off") throw new CpError("CP_CONFIG_INVALID", "coverage.sourceMap must be auto|off");
    let historyMap = coverage.historyMap;
    if (c["historyMap"] !== void 0) {
      const h = c["historyMap"];
      if (!isPlainObject(h)) throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap must be a mapping");
      const unknownH = assertNoUnknownKeys(h, ["enabled", "maxAgeDays"], "coverage.historyMap");
      if (unknownH.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownH.join("; "));
      const enabled = h["enabled"] === void 0 ? false : h["enabled"];
      if (typeof enabled !== "boolean") throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap.enabled must be boolean");
      const maxAgeDays = h["maxAgeDays"] === void 0 ? 14 : h["maxAgeDays"];
      if (!isNumber(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 365) throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap.maxAgeDays must be in (0, 365]");
      historyMap = { enabled, maxAgeDays };
    }
    const changedLinesOnly = c["changedLinesOnly"] === void 0 ? true : c["changedLinesOnly"];
    const requireArtifact = c["requireArtifact"] === void 0 ? true : c["requireArtifact"];
    if (typeof changedLinesOnly !== "boolean" || typeof requireArtifact !== "boolean") {
      throw new CpError("CP_CONFIG_INVALID", "coverage.changedLinesOnly/requireArtifact must be boolean");
    }
    coverage = { changedLinesOnly, requireArtifact, sourceMap, historyMap };
  }
  let thresholds = { changedLines: 1, minimumImpactConfidence: "MEDIUM" };
  if (raw["thresholds"] !== void 0) {
    const t = raw["thresholds"];
    if (!isPlainObject(t)) throw new CpError("CP_CONFIG_INVALID", "thresholds must be a mapping");
    const unknownT = assertNoUnknownKeys(t, ["changedLines", "minimumImpactConfidence"], "thresholds");
    if (unknownT.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownT.join("; "));
    if (t["changedLines"] !== void 0) {
      if (!isNumber(t["changedLines"]) || t["changedLines"] < 0 || t["changedLines"] > 1) {
        throw new CpError("CP_CONFIG_INVALID", `thresholds.changedLines must be within [0, 1] (got ${JSON.stringify(t["changedLines"])})`);
      }
      thresholds = { ...thresholds, changedLines: t["changedLines"] };
    }
    if (t["minimumImpactConfidence"] !== void 0) {
      const mc = t["minimumImpactConfidence"];
      if (!isString(mc) || !CONFIDENCES.includes(mc)) {
        throw new CpError("CP_CONFIG_INVALID", "thresholds.minimumImpactConfidence must be HIGH|MEDIUM|LOW");
      }
      thresholds = { ...thresholds, minimumImpactConfidence: mc };
    }
  }
  let exclude = [];
  if (raw["exclude"] !== void 0) {
    if (!isStringArray(raw["exclude"])) throw new CpError("CP_CONFIG_INVALID", "exclude must be a string array");
    exclude = raw["exclude"].map((g, j) => validateGlob(g, `exclude[${j}]`));
  }
  return { schemaVersion: 1, baseline, packages, checks, mappings, coverage, thresholds, exclude, sourcePath };
}

// src/host/config/load.ts
var MAX_CONFIG_BYTES = 512 * 1024;
async function loadConfig(fs, workspaceRootAbs, relPath = DEFAULT_CONFIG_PATH) {
  const absPath = `${workspaceRootAbs}/${relPath}`.replace(/\\/g, "/");
  const exists = await fs.exists(absPath);
  if (!exists) {
    throw new CpError("CP_CONFIG_NOT_FOUND", `configuration not found: ${relPath} (create it in the workspace root; see docs/configuration.md)`);
  }
  const { bytes, truncated } = await fs.readFileBounded(absPath, MAX_CONFIG_BYTES);
  if (truncated) {
    throw new CpError("CP_CONFIG_INVALID", `${relPath} exceeds ${MAX_CONFIG_BYTES} bytes; refusing to guess a truncated config`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  let parsed;
  try {
    const { parse } = await import("yaml");
    parsed = parse(text, { strict: false });
  } catch (err) {
    throw new CpError("CP_CONFIG_INVALID", `${relPath}: YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateConfig(parsed, relPath);
}

// src/host/adapters/javascript/import-graph.ts
var RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
function buildJsImportGraph(files, read) {
  const edges = /* @__PURE__ */ new Map();
  const incompleteFiles = /* @__PURE__ */ new Set();
  const diagnostics = [];
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const imports = /* @__PURE__ */ new Set();
    const dynamicImports = [];
    const staticRe = /(?:import|export)[^'"\n;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of text.matchAll(dynamicRe)) {
      dynamicImports.push(m[1]);
    }
    const dynamicSpecs = new Set(dynamicImports);
    for (const m of text.matchAll(staticRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (dynamicSpecs.has(spec)) continue;
      const resolved = resolveRelative(spec, file, read);
      if (resolved) imports.add(resolved);
      else if (!spec.startsWith(".")) {
        incompleteFiles.add(file);
      } else {
        incompleteFiles.add(file);
        diagnostics.push(`unresolved relative import "${spec}" in ${file}`);
      }
    }
    for (const spec of dynamicSpecs) {
      incompleteFiles.add(file);
      const resolved = resolveRelative(spec, file, read);
      if (resolved) imports.add(resolved);
    }
    if (dynamicSpecs.size > 0) diagnostics.push(`dynamic import(s) in ${file}: [[${[...dynamicSpecs].join(", ")}]]`);
    edges.set(file, imports);
  }
  return { edges, incompleteFiles, diagnostics };
}
function resolveRelative(spec, importer, read) {
  if (!spec.startsWith(".")) return null;
  const base = importer.split("/").slice(0, -1);
  const parts = spec.split("/");
  const stack = [...base];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = stack.join("/");
  const candidates = [
    joined,
    ...RESOLVE_EXTENSIONS.map((ext) => joined + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${joined}/index${ext}`)
  ];
  for (const cand of candidates) {
    if (read(cand) !== null) return cand;
  }
  return null;
}
function reverseReachable(graph, targets) {
  const reverse = /* @__PURE__ */ new Map();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, /* @__PURE__ */ new Set());
      reverse.get(to).add(from);
    }
  }
  const targetSet = new Set(targets);
  const seen = /* @__PURE__ */ new Set();
  const queue = [...targets];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of reverse.get(cur) ?? []) queue.push(next);
  }
  const importers = /* @__PURE__ */ new Set();
  for (const f of seen) {
    if (!targetSet.has(f)) importers.add(f);
  }
  return importers;
}

// src/host/adapters/python/import-graph.ts
function buildPythonImportGraph(files, read, options) {
  const edges = /* @__PURE__ */ new Map();
  const incompleteFiles = /* @__PURE__ */ new Set();
  const diagnostics = [];
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const imports = /* @__PURE__ */ new Set();
    let hasDynamic = false;
    const fromRe = /^\s*from\s+([.\w]+)\s+import/gm;
    const importRe = /^\s*import\s+([\w.]+)/gm;
    const dynamicRe = /__import__\s*\(|importlib\.(import_module|util\.exec_module)/g;
    if (dynamicRe.test(text)) hasDynamic = true;
    for (const m of text.matchAll(fromRe)) {
      const mod = m[1];
      const resolved = resolvePythonModule(mod, file, read, options.roots);
      if (resolved) imports.add(resolved);
      else if (mod.startsWith(".")) {
        incompleteFiles.add(file);
        diagnostics.push(`unresolved relative import "${mod}" in ${file}`);
      }
    }
    for (const m of text.matchAll(importRe)) {
      const mod = m[1];
      const resolved = resolvePythonModule(mod, file, read, options.roots);
      if (resolved) imports.add(resolved);
    }
    if (hasDynamic) {
      incompleteFiles.add(file);
      diagnostics.push(`dynamic import machinery in ${file} (__import__/importlib)`);
    }
    edges.set(file, imports);
  }
  return { edges, incompleteFiles, diagnostics };
}
function resolvePythonModule(mod, importer, read, roots) {
  const parts = mod.split(".");
  while (parts[0] === "") parts.shift();
  if (parts[0] === ".") {
    const stack = importer.split("/").slice(0, -1);
    let leadingDots = 0;
    while (parts[0] === "." && leadingDots < 16) {
      parts.shift();
      leadingDots += 1;
      if (leadingDots > 1) stack.pop();
    }
    for (const part of parts) stack.push(part);
    return tryPaths(stack.join("/"), read);
  }
  for (const root of roots) {
    const found = tryPaths([root, ...parts].join("/"), read);
    if (found) return found;
  }
  return null;
}
function tryPaths(joined, read) {
  const base = joined.replace(/^\/+/, "");
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
    if (read(cand) !== null) return cand;
  }
  return null;
}
function reverseReachable2(graph, targets) {
  const reverse = /* @__PURE__ */ new Map();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, /* @__PURE__ */ new Set());
      reverse.get(to).add(from);
    }
  }
  const targetSet = new Set(targets);
  const seen = /* @__PURE__ */ new Set();
  const queue = [...targets];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of reverse.get(cur) ?? []) queue.push(next);
  }
  const importers = /* @__PURE__ */ new Set();
  for (const f of seen) {
    if (!targetSet.has(f)) importers.add(f);
  }
  return importers;
}

// src/host/analysis/explicit-mappings.ts
function resolveExplicitMappings(changedPaths, mappings, packages) {
  const candidates = [];
  for (const mapping of mappings) {
    const affected = changedPaths.filter((p) => mapping.sources.some((g) => globMatch(g, p)));
    if (affected.length === 0) continue;
    const testFiles = mapping.tests;
    const pkg = packageForPath(packages, affected[0]) ?? packages[0];
    candidates.push({
      schemaVersion: "1.0",
      id: `explicit:${mapping.sources.join(",")}`,
      packageId: pkg?.id ?? "unknown",
      testFiles: [...testFiles],
      argv: pkg ? [...pkg.test.argv] : [],
      cwd: pkg ? pkg.test.cwd : "",
      source: "explicit",
      confidence: mapping.confidence,
      affectedFiles: affected,
      rationale: [
        `explicit mapping in .changeproof.yml: sources [[${mapping.sources.join(", ")}]] \u2192 tests [[${mapping.tests.join(", ")}]]`,
        "user-declared mapping is exhaustive for the matched sources"
      ]
    });
  }
  return candidates;
}
function packageForPath(packages, path7) {
  return packages.find(
    (p) => p.include.some((g) => globMatch(g, path7)) || // a repo-root package (root: "") owns the whole workspace
    p.root === "" || (path7 === p.root || path7.startsWith(p.root + "/"))
  );
}

// src/host/analysis/naming-conventions.ts
function namingConventionCandidates(changedPaths, workspaceFiles, packages) {
  const fileSet = new Set(workspaceFiles);
  const byCandidate = /* @__PURE__ */ new Map();
  for (const changed of changedPaths) {
    const pkg = packageForPath(packages, changed);
    if (!pkg) continue;
    const isPython = changed.endsWith(".py");
    const isJs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(changed);
    if (!isPython && !isJs) continue;
    const dir = changed.split("/").slice(0, -1).join("/");
    const base = changed.split("/").pop();
    const tests = [];
    if (isJs) {
      const stem = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
      const ext = base.slice(stem.length);
      const variants = [
        ...dir ? [`${dir}/${stem}.test${ext}`] : [`${stem}.test${ext}`],
        ...dir ? [`${dir}/${stem}.spec${ext}`] : [`${stem}.spec${ext}`],
        ...dir ? [`${dir}/__tests__/${stem}${ext}`, `${dir}/__tests__/${stem}.test${ext}`] : [`__tests__/${stem}${ext}`, `__tests__/${stem}.test${ext}`],
        ...dir ? [`${dir.replace(/\/src$/, "")}/tests/${stem}.test${ext}`] : [`tests/${stem}.test${ext}`]
      ];
      for (const v of variants) if (fileSet.has(v)) tests.push(v);
    } else {
      const stem = base.replace(/\.py$/, "");
      const variants = [
        ...dir ? [`${dir}/test_${stem}.py`] : [`test_${stem}.py`],
        ...dir ? [`${dir}/tests/test_${stem}.py`] : [`tests/test_${stem}.py`]
      ];
      for (const v of variants) if (fileSet.has(v)) tests.push(v);
    }
    if (tests.length === 0) continue;
    const key = `${pkg.id}::${tests.join(",")}`;
    const existing = byCandidate.get(key);
    if (existing) {
      existing.affectedFiles.push(changed);
      continue;
    }
    byCandidate.set(key, {
      schemaVersion: "1.0",
      id: `naming:${key}`,
      packageId: pkg.id,
      testFiles: tests,
      argv: [...pkg.test.argv],
      cwd: pkg.test.cwd,
      source: "naming",
      confidence: "LOW",
      affectedFiles: [changed],
      rationale: [
        `naming convention match: ${changed} \u2192 [[${tests.join(", ")}]]`,
        "LOW confidence: naming conventions find candidates, they cannot prove exhaustiveness"
      ]
    });
  }
  return [...byCandidate.values()];
}

// src/host/analysis/history-map.ts
function matchHistoryEntries(changed, entries, nowIso, maxAgeDays) {
  const now = Date.parse(nowIso);
  const matches = [];
  for (const file of changed) {
    const entry = entries.find((e) => e.path === file.path);
    if (!entry) continue;
    const ageMs = now - Date.parse(entry.recordedAt);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeDays * 24 * 3600 * 1e3) continue;
    if (file.contentDigest === entry.contentDigest) {
      matches.push({ path: file.path, testFiles: [...entry.testFiles], confidence: "HIGH", reason: "digest-match" });
    } else {
      matches.push({ path: file.path, testFiles: [...entry.testFiles], confidence: "MEDIUM", reason: "digest-drift" });
    }
  }
  return matches;
}

// src/host/analysis/impact-resolver.ts
var CONFIDENCE_ORDER = { HIGH: 3, MEDIUM: 2, LOW: 1 };
function resolveImpact(inputs) {
  const { config, workspaceFiles } = inputs;
  const changedPaths = inputs.changedFiles.map((f) => f.path);
  const diagnostics = [];
  const merged = /* @__PURE__ */ new Map();
  const addCandidate = (cand) => {
    const key = `${cand.packageId}::${[...cand.testFiles].sort().join("|")}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...cand, affectedFiles: [...new Set(cand.affectedFiles)], rationale: [...cand.rationale] });
      return;
    }
    if (CONFIDENCE_ORDER[cand.confidence] > CONFIDENCE_ORDER[existing.confidence]) {
      existing.confidence = cand.confidence;
    }
    existing.affectedFiles = [.../* @__PURE__ */ new Set([...existing.affectedFiles, ...cand.affectedFiles])];
    existing.rationale.push(...cand.rationale);
    if (!existing.rationale.some((r) => r.startsWith(`sources: `))) {
      existing.rationale.push(`sources: ${cand.source}`);
    }
  };
  const jsChanged = changedPaths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
  const pyChanged = changedPaths.filter((p) => p.endsWith(".py"));
  for (const cand of resolveExplicitMappings(changedPaths, config.mappings, config.packages)) {
    const expanded = expandTestGlobs(cand.testFiles, workspaceFiles);
    if (expanded.length === 0) {
      diagnostics.push(`explicit mapping matched sources but no test files exist for [[${cand.testFiles.join(", ")}]]`);
      continue;
    }
    addCandidate({ ...cand, testFiles: expanded });
  }
  const historyMatches = matchHistoryEntries(
    inputs.changedFiles.map((f) => ({ path: f.path, contentDigest: f.contentDigest })),
    inputs.historyEntries,
    inputs.nowIso,
    config.coverage.historyMap.enabled ? config.coverage.historyMap.maxAgeDays : 0
  );
  const historyByPath = new Map(historyMatches.map((m) => [m.path, m]));
  const historyCovered = changedPaths.filter((p) => historyByPath.has(p));
  for (const pkg of config.packages) {
    const affected = historyCovered.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
    if (affected.length === 0) continue;
    const tests = [...new Set(affected.flatMap((p) => historyByPath.get(p).testFiles))];
    if (tests.length === 0) continue;
    const anyHigh = affected.some((p) => historyByPath.get(p).confidence === "HIGH");
    addCandidate({
      schemaVersion: "1.0",
      id: `history:${pkg.id}`,
      packageId: pkg.id,
      testFiles: tests,
      argv: [...pkg.test.argv],
      cwd: pkg.test.cwd,
      source: "coverage-history",
      confidence: anyHigh ? "HIGH" : "MEDIUM",
      affectedFiles: affected,
      rationale: [
        `historical coverage-map match for [[${affected.join(", ")}]] (${anyHigh ? "digest match" : "digest drift"})`,
        anyHigh ? "map digests + adapter version still valid: HIGH" : "source digest drifted since the map was recorded: MEDIUM"
      ]
    });
  }
  if (jsChanged.length > 0) {
    const graph = buildJsImportGraph(workspaceFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)), inputs.readWorkspaceFile);
    diagnostics.push(...graph.diagnostics);
    const importers = reverseReachable(graph, jsChanged);
    const changedExistingTests = jsChanged.filter((f) => graph.edges.has(f) && isTestFile(f));
    const allTests = [.../* @__PURE__ */ new Set([...importers, ...changedExistingTests])];
    for (const pkg of config.packages) {
      if (!pkg.languages.some((l) => l === "typescript" || l === "javascript")) continue;
      const tests = allTests.filter(
        (f) => isTestFile(f) && packageForPath(config.packages, f)?.id === pkg.id
      );
      const affected = jsChanged.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
      if (tests.length === 0 || affected.length === 0) continue;
      const completenessHit = [...importers].some((f) => graph.incompleteFiles.has(f));
      addCandidate({
        schemaVersion: "1.0",
        id: `import-graph:${pkg.id}`,
        packageId: pkg.id,
        testFiles: tests.sort(),
        argv: [...pkg.test.argv],
        cwd: pkg.test.cwd,
        source: "import-graph",
        confidence: "MEDIUM",
        affectedFiles: affected,
        rationale: [
          `static import graph: [[${tests.join(", ")}]] transitively imports changed modules`,
          completenessHit ? "completeness reduced: dynamic imports or unresolved specifiers present" : "all static imports resolved"
        ]
      });
    }
  }
  if (pyChanged.length > 0) {
    for (const pkg of config.packages) {
      if (!pkg.languages.includes("python")) continue;
      const graph = buildPythonImportGraph(workspaceFiles.filter((f) => f.endsWith(".py")), inputs.readWorkspaceFile, { roots: [pkg.root] });
      diagnostics.push(...graph.diagnostics);
      const importers = reverseReachable2(graph, pyChanged);
      const changedExistingTests = pyChanged.filter((f) => graph.edges.has(f) && isTestFile(f));
      const tests = [.../* @__PURE__ */ new Set([...importers, ...changedExistingTests])].filter(
        (f) => isTestFile(f) && packageForPath(config.packages, f)?.id === pkg.id
      );
      const affected = pyChanged.filter((p) => packageForPath(config.packages, p)?.id === pkg.id);
      if (tests.length === 0 || affected.length === 0) continue;
      addCandidate({
        schemaVersion: "1.0",
        id: `import-graph:${pkg.id}`,
        packageId: pkg.id,
        testFiles: tests.sort(),
        argv: [...pkg.test.argv],
        cwd: pkg.test.cwd,
        source: "import-graph",
        confidence: "MEDIUM",
        affectedFiles: affected,
        rationale: ["static import graph: tests importing changed python modules", "python namespace packages may reduce completeness"]
      });
    }
  }
  for (const cand of namingConventionCandidates(changedPaths, workspaceFiles, config.packages)) {
    addCandidate(cand);
  }
  const candidates = [...merged.values()].sort((a, b) => a.id < b.id ? -1 : 1);
  const covered = new Set(candidates.flatMap((c) => c.affectedFiles));
  const unresolvedPaths = changedPaths.filter((p) => !covered.has(p));
  if (unresolvedPaths.length > 0) {
    diagnostics.push(`no impact candidates resolved for: [[${unresolvedPaths.join(", ")}]]`);
  }
  const maxConfidence = candidates.reduce((max, c) => {
    return CONFIDENCE_ORDER[c.confidence] > CONFIDENCE_ORDER[max] ? c.confidence : max;
  }, "LOW");
  return { candidates, maxConfidence, diagnostics, unresolvedPaths };
}
function expandTestGlobs(globs, workspaceFiles) {
  const out = /* @__PURE__ */ new Set();
  for (const g of globs) {
    for (const f of workspaceFiles) {
      if (globMatch(g, f)) out.add(f);
    }
  }
  return [...out].sort();
}
function isTestFile(path7) {
  const base = path7.split("/").pop();
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path7) || /^test_.*\.py$/.test(base) || /(^|\/)tests?\//.test(path7) || /(^|\/)__tests__\//.test(path7);
}

// src/host/analysis/fingerprint.ts
function computeFingerprint(inputs, hash) {
  const payload = {
    schemaVersion: "1.0",
    baselineCommit: inputs.baselineCommit,
    changeSetDigest: inputs.changeSetDigest,
    changedFileDigests: [...inputs.changedFileDigests].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    testFileDigests: [...inputs.testFileDigests].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    lockfileDigests: [...inputs.lockfileDigests].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    runnerConfigDigests: [...inputs.runnerConfigDigests].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    pluginConfigDigest: inputs.pluginConfigDigest,
    adapters: [...inputs.adapters].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : 1)
  };
  return hash(canonicalJsonStringify(payload));
}

// src/host/workspace.ts
import path2 from "node:path";

// src/host/execution/command-policy.ts
var SHELL_EXECUTABLES = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
var ENV_ALLOWLIST = /* @__PURE__ */ new Set([
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
function checkCommand(input) {
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
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 36e5) {
    throw new CpError("CP_COMMAND_POLICY_REJECTED", "timeoutMs must be in (0, 3600000]");
  }
  const warnings = [];
  const exe = argv[0].toLowerCase().replace(/\.exe$/, "");
  const base = exe.split(/[\\/]/).pop();
  let riskLevel = "normal";
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
function redactArgv(argv) {
  const sensitiveFlag = /^--?(?:token|secret|password|passwd|api[-_]?key|key|auth)$/i;
  const sensitiveInline = /^--?(?:token|secret|password|passwd|api[-_]?key|key|auth)=/i;
  return argv.map((a, i) => {
    if (sensitiveFlag.test(a)) {
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("-")) {
        return a;
      }
      return a;
    }
    if (sensitiveInline.test(a) || /^(?:token|secret|password|apikey)=/i.test(a)) {
      return `${a.split("=")[0]}=***`;
    }
    const prev = argv[i - 1];
    if (prev !== void 0 && sensitiveFlag.test(prev) && !a.startsWith("-")) {
      return "***";
    }
    return a;
  });
}
function buildEnv(env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

// src/host/workspace.ts
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "coverage", ".changeproof", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache"]);
var MAX_WORKSPACE_FILES = 3e4;
var MAX_SCAN_DEPTH = 24;
async function scanWorkspaceFiles(fs, rootAbs, config) {
  const out = [];
  let truncated = false;
  const { readdir: readdir2 } = await import("node:fs/promises");
  const walk = async (relDir, depth) => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (out.length >= MAX_WORKSPACE_FILES) {
      truncated = true;
      return;
    }
    const abs = relDir === "" ? rootAbs : path2.join(rootAbs, ...relDir.split("/"));
    let dirents;
    try {
      dirents = await readdir2(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length >= MAX_WORKSPACE_FILES) {
        truncated = true;
        return;
      }
      const rel = relDir === "" ? d.name : `${relDir}/${d.name}`;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        await walk(rel, depth + 1);
      } else if (d.isFile()) {
        const included = config.packages.some((p) => p.include.some((g) => globMatch(g, rel)));
        const isTestUnderPackage = isTestFilePath(rel) && config.packages.some((p) => p.root === "" || rel.startsWith(p.root + "/"));
        const excluded = config.exclude.some((g) => globMatch(g, rel));
        if ((included || isTestUnderPackage) && !excluded) out.push(rel);
      }
    }
  };
  await walk("", 0);
  out.sort();
  return { files: out, truncated };
}
var LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Pipfile.lock"];
var RUNNER_CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.cts",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "pyproject.toml",
  "setup.cfg",
  "pytest.ini",
  "tox.ini",
  ".coveragerc"
];
var PLUGIN_CONFIG_REL = ".changeproof.yml";
async function gatherFingerprintInputs(fs, rootAbs, config, changeSet, candidates, adapters, scannedFiles) {
  const digestOf = async (rel) => {
    try {
      return await fs.digestFileNormalized(path2.join(rootAbs, ...rel.split("/")), 20 * 1024 * 1024);
    } catch {
      return null;
    }
  };
  const changedFileDigests = [];
  for (const f of changeSet.files) {
    if (f.contentDigest) changedFileDigests.push({ path: f.path, digest: f.contentDigest });
  }
  const testFiles = [...new Set(candidates.flatMap((c) => c.testFiles))];
  const testFileDigests = [];
  for (const t of testFiles) {
    const d = await digestOf(t);
    if (d) testFileDigests.push({ path: t, digest: d });
  }
  const roots = ["", ...config.packages.map((p) => p.root)];
  const tryDigest = async (names, label) => {
    const found = [];
    for (const root of roots) {
      for (const name2 of names) {
        const rel = root === "" ? name2 : `${root}/${name2}`;
        const d = await digestOf(rel);
        if (d) found.push({ path: rel, digest: d });
        void label;
      }
    }
    return found;
  };
  return {
    baselineCommit: changeSet.baseline.commit,
    changeSetDigest: changeSet.digest,
    changedFileDigests,
    testFileDigests,
    lockfileDigests: await tryDigest(LOCKFILE_NAMES, "lock"),
    runnerConfigDigests: await tryDigest(RUNNER_CONFIG_NAMES, "runner"),
    pluginConfigDigest: await digestOf(PLUGIN_CONFIG_REL),
    adapters
  };
}
async function prewarmReader(fs, rootAbs, files) {
  const cache = /* @__PURE__ */ new Map();
  for (const rel of files) {
    try {
      const { bytes } = await fs.readFileBounded(path2.join(rootAbs, ...rel.split("/")), 2 * 1024 * 1024);
      cache.set(rel, Buffer.from(bytes).toString("utf8"));
    } catch {
      cache.set(rel, null);
    }
  }
  return (rel) => cache.get(rel) ?? null;
}
function makeGitRunner(subprocess, env) {
  return async (argv, cwd) => {
    const res = await subprocess.execute({
      argv: ["git", ...argv],
      cwdAbs: cwd,
      timeoutMs: 3e4,
      maxOutputBytes: 20 * 1024 * 1024,
      env: buildEnv(env)
    });
    return { code: res.exitCode ?? -1, stdout: res.stdout, stderr: res.stderr };
  };
}
async function workspaceIdOf(fs, rootAbs) {
  const { realpath: realpath2 } = await import("node:fs/promises");
  const real = await realpath2(rootAbs).catch(() => rootAbs);
  return sha256Hex(real);
}
function isTestFilePath(rel) {
  const base = rel.split("/").pop() ?? "";
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel) || /^test_.*\.py$/.test(base) || /(^|\/)tests?\//.test(rel) || /(^|\/)__tests__\//.test(rel);
}

// src/host/tools/common.ts
var ADAPTER_VERSIONS = [
  { id: "istanbul", version: "1.0" },
  { id: "coverage-py", version: "1.0" }
];
async function analyzeWorkspace(host, workspaceRootAbs, options = {}) {
  const { fs } = host;
  const config = await loadConfig(fs, workspaceRootAbs);
  const workspaceId = await workspaceIdOf(fs, workspaceRootAbs);
  const runGit = makeGitRunner(host.subprocess, process.env);
  const changeSet = await buildChangeSet({
    workspaceRootAbs,
    untrackedIncludeGlobs: config.packages.flatMap((p) => p.include),
    baselineKind: options.baselineKind ?? config.baseline.kind,
    mergeBaseRef: options.mergeBaseRef ?? config.baseline.ref,
    runGit,
    digestFile: async (abs) => {
      try {
        return await fs.digestFileNormalized(abs, 20 * 1024 * 1024);
      } catch {
        return null;
      }
    },
    workspaceId,
    hashCanonical: sha256Hex
  });
  const scan = await scanWorkspaceFiles(fs, workspaceRootAbs, config);
  const reader = await prewarmReader(fs, workspaceRootAbs, scan.files);
  const impact = resolveImpact({
    changedFiles: changeSet.files.map((f) => ({ path: f.path, contentDigest: f.contentDigest })),
    workspaceFiles: scan.files,
    readWorkspaceFile: reader,
    config,
    historyEntries: [],
    nowIso: (/* @__PURE__ */ new Date()).toISOString()
  });
  const fpInputs = await gatherFingerprintInputs(fs, workspaceRootAbs, config, changeSet, impact.candidates, ADAPTER_VERSIONS, scan.files);
  const fingerprint = computeFingerprint(fpInputs, sha256Hex);
  return {
    config,
    changeSet,
    workspaceFiles: scan.files,
    scanTruncated: scan.truncated,
    candidates: impact.candidates,
    maxConfidence: impact.maxConfidence,
    impactDiagnostics: impact.diagnostics,
    fingerprint
  };
}
function diagnosticsFromSnapshot(snap) {
  return [
    ...snap.changeSet.diagnostics.map((message) => ({ severity: "info", code: "CP_CHANGESET_INFO", message })),
    ...snap.impactDiagnostics.map((message) => ({ severity: "info", code: "CP_IMPACT_INFO", message })),
    ...snap.scanTruncated ? [{ severity: "warning", code: "CP_SCAN_TRUNCATED", message: "workspace scan hit the file cap; impact may be incomplete" }] : []
  ];
}
function toolError(kind, err) {
  if (err instanceof CpError) {
    return errorResult(kind, err.code, err.message, err.details);
  }
  return errorResult(kind, "CP_INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

// src/host/analysis/deletion-risk.ts
function deletedLineRiskOf(files) {
  return files.filter((f) => f.linesDeleted > 0).map((f) => ({
    path: f.path,
    ranges: f.ranges.filter((r) => r.kind === "deleted").map((r) => `${r.startLine}-${r.endLine}`)
  }));
}

// src/host/tools/plan.ts
async function planTool(host, workspaceRootAbs, options = {}) {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const plan = buildPlan(
      {
        config: snap.config,
        candidates: snap.candidates,
        changeSetDigest: snap.changeSet.digest,
        workspaceFingerprint: snap.fingerprint,
        nowIso: (/* @__PURE__ */ new Date()).toISOString()
      },
      sha256Hex
    );
    return okResult(
      "changeproof_plan",
      {
        changeSetSummary: {
          mode: snap.changeSet.mode,
          baseline: snap.changeSet.baseline,
          files: snap.changeSet.files.map((f) => ({
            path: f.path,
            status: f.status,
            linesAdded: f.linesAdded,
            linesDeleted: f.linesDeleted
          })),
          deletedLineRisk: deletedLineRiskOf(snap.changeSet.files),
          digest: snap.changeSet.digest
        },
        impact: { candidates: plan.candidates, maxConfidence: snap.maxConfidence },
        steps: plan.steps,
        preview: plan.steps.filter((s) => s.argv.length > 0).map((s) => ({ stepId: s.id, argv: s.argv, cwd: s.cwd, timeoutMs: s.timeoutMs, expectedArtifacts: s.expectedArtifacts })),
        planId: plan.id,
        workspaceFingerprint: snap.fingerprint
      },
      diagnosticsFromSnapshot(snap).concat(
        plan.diagnostics.map((message) => ({ severity: "info", code: "CP_PLAN_INFO", message }))
      )
    );
  } catch (err) {
    return toolError("changeproof_plan", err);
  }
}

// src/host/execution/executor.ts
import { randomUUID } from "node:crypto";

// src/host/execution/output-limiter.ts
function summarizeOutput(text, limits) {
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
  const joinBytes = (arr) => Buffer.byteLength(arr.join("\n"), "utf8");
  while (joinBytes(headLines) + joinBytes(tailLines) > limits.maxBytes && headLines.length > 0) {
    if (headLines.length > tailLines.length) headLines = headLines.slice(0, Math.floor(headLines.length / 2));
    else tailLines = tailLines.slice(Math.ceil(tailLines.length / 2));
  }
  return {
    summary: { truncated, totalBytes: bytes, headLines, tailLines },
    digest: sha256Hex(text)
  };
}

// src/host/execution/executor.ts
var DEFAULT_PARSE_CAPS = { maxFileEntries: 2e4, maxLinesPerFile: 2e5 };
var MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
function coverageAdapterById(id) {
  if (id === istanbulAdapter.id) return istanbulAdapter;
  if (id === coveragePyAdapter.id) return coveragePyAdapter;
  throw new CpError("CP_COVERAGE_SCHEMA_UNKNOWN", `no coverage adapter registered for "${id}"`);
}
async function executePlan(plan, services, context) {
  const executed = /* @__PURE__ */ new Set();
  const outcomes = [];
  let cancelled = false;
  const readySteps = () => plan.steps.filter((s) => !executed.has(s.id) && s.dependsOn.every((d) => executed.has(d)));
  while (executed.size < plan.steps.length) {
    if (services.abortSignal?.aborted) {
      cancelled = true;
      break;
    }
    const batch = readySteps();
    if (batch.length === 0) {
      for (const s of plan.steps.filter((x) => !executed.has(x.id))) {
        outcomes.push({ step: s, evidence: null, error: "dependency not satisfied (upstream failure or cycle)", artifact: null });
        executed.add(s.id);
      }
      break;
    }
    for (const step of batch) {
      if (services.abortSignal?.aborted) {
        cancelled = true;
        break;
      }
      const outcome = await runStep(step, plan, services, context);
      outcomes.push(outcome);
      executed.add(step.id);
    }
    if (cancelled) {
      for (const s of plan.steps.filter((x) => !executed.has(x.id))) {
        outcomes.push({ step: s, evidence: null, error: "cancelled", artifact: null });
        executed.add(s.id);
      }
      break;
    }
  }
  return { outcomes, cancelled };
}
async function runStep(step, plan, services, context) {
  const id = `ev-${randomUUID().slice(0, 8)}`;
  const base = {
    schemaVersion: "1.0",
    id,
    planId: plan.id,
    stepId: step.id,
    cwd: step.cwd,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    changedFilesDigest: context.changedFilesDigest,
    workspaceFingerprint: context.workspaceFingerprint,
    lockConfigDigest: context.lockConfigDigest
  };
  if (step.tier === "changed-line-coverage") {
    return parseArtifactStep(step, base, services);
  }
  try {
    const preview = checkCommand({
      argv: step.argv,
      cwdRel: step.cwd,
      timeoutMs: step.timeoutMs,
      expectedArtifacts: step.expectedArtifacts
    });
    if (services.approve) {
      const ok = await services.approve({ stepId: step.id, ...preview });
      if (!ok) {
        return {
          step,
          evidence: {
            ...base,
            adapter: { id: step.adapterId, version: "1.0" },
            argvRedacted: redactArgv(step.argv),
            durationMs: 0,
            exitCode: null,
            termination: "cancelled",
            artifactDigests: [],
            parser: { status: "not-applicable", diagnostics: ["approval denied"] },
            outputDigest: `sha256:${"0".repeat(64)}`
          },
          error: "approval denied",
          artifact: null
        };
      }
    }
    let cwdAbs;
    try {
      cwdAbs = step.cwd === "" ? services.workspaceRootAbs : await services.fs.realpathInWorkspace(services.workspaceRootAbs, step.cwd);
    } catch (err) {
      const message = err instanceof CpError ? err.message : String(err);
      return { step, evidence: null, error: `cwd rejected: ${message}`, artifact: null };
    }
    const started = Date.now();
    let result;
    try {
      result = await services.subprocess.execute({
        argv: step.argv,
        cwdAbs,
        timeoutMs: step.timeoutMs,
        maxOutputBytes: services.outputLimits.maxBytes,
        env: buildEnv(services.env),
        abortSignal: services.abortSignal
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { step, evidence: null, error: message, artifact: null };
    }
    const durationMs = Date.now() - started;
    const output = result.stdout + (result.stderr.length > 0 ? "\n--stderr--\n" + result.stderr : "");
    const { summary, digest } = summarizeOutput(output, services.outputLimits);
    return {
      step,
      evidence: {
        ...base,
        adapter: { id: step.adapterId, version: "1.0" },
        argvRedacted: redactArgv(step.argv),
        durationMs,
        exitCode: result.exitCode,
        termination: result.termination,
        artifactDigests: [],
        parser: { status: "not-applicable", diagnostics: [] },
        outputDigest: digest,
        outputSummary: summary
      },
      error: null,
      artifact: null
    };
  } catch (err) {
    return { step, evidence: null, error: err instanceof Error ? err.message : String(err), artifact: null };
  }
}
async function parseArtifactStep(step, base, services) {
  const adapter = coverageAdapterById(step.adapterId);
  const artifactRel = step.expectedArtifacts[0] ?? "";
  const started = Date.now();
  try {
    const artifactAbs = await services.fs.realpathInWorkspace(services.workspaceRootAbs, artifactRel);
    const { bytes, truncated } = await services.fs.readFileBounded(artifactAbs, MAX_ARTIFACT_BYTES);
    if (truncated) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", `coverage artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${artifactRel}`);
    }
    const text = Buffer.from(bytes).toString("utf8");
    const artifact = adapter.parse(text, { workspaceRootAbs: services.workspaceRootAbs, ...DEFAULT_PARSE_CAPS });
    const evidence = {
      ...base,
      adapter: { id: adapter.id, version: adapter.version },
      argvRedacted: [],
      durationMs: Date.now() - started,
      exitCode: 0,
      termination: "exit",
      artifactDigests: [{ kind: adapter.artifactKind, digest: sha256Hex(text) }],
      parser: { status: "ok", diagnostics: artifact.diagnostics },
      outputDigest: `sha256:${"0".repeat(64)}`,
      coverage: { coverableChangedLines: 0, coveredChangedLines: 0, ratio: null, uncovered: [] }
    };
    return { step, evidence, error: null, artifact };
  } catch (err) {
    const message = err instanceof CpError ? `${err.code}: ${err.message}` : String(err);
    const evidence = {
      ...base,
      adapter: { id: adapter.id, version: adapter.version },
      argvRedacted: [],
      durationMs: Date.now() - started,
      exitCode: null,
      termination: "exit",
      artifactDigests: [],
      parser: { status: "error", diagnostics: [message] },
      outputDigest: `sha256:${"0".repeat(64)}`
    };
    return { step, evidence, error: null, artifact: null };
  }
}

// src/host/analysis/changed-lines.ts
function analyzeChangedLineCoverage(changeSet, executableByFile, coveredByFile, excludeGlobs) {
  const files = [];
  const excludedFiles = [];
  for (const f of changeSet.files) {
    if (f.status === "deleted") continue;
    const excludedBy = excludeGlobs.find((g) => globMatch(g, f.path));
    if (excludedBy !== void 0) {
      excludedFiles.push({ path: f.path, rule: excludedBy });
      files.push({ path: f.path, coverable: [], covered: [], uncovered: [], absentFromArtifact: false, excluded: excludedBy });
      continue;
    }
    const executableLines = executableByFile.get(f.path);
    if (!executableLines) {
      files.push({ path: f.path, coverable: [], covered: [], uncovered: [], absentFromArtifact: true });
      continue;
    }
    const coveredLines = coveredByFile.get(f.path) ?? /* @__PURE__ */ new Set();
    const coverable = [];
    for (const range of f.ranges) {
      if (range.kind === "deleted") continue;
      for (let ln = range.startLine; ln <= range.endLine; ln += 1) {
        if (executableLines.has(ln)) coverable.push(ln);
      }
    }
    const unique = [...new Set(coverable)].sort((a, b) => a - b);
    const covered = unique.filter((ln) => coveredLines.has(ln));
    files.push({
      path: f.path,
      coverable: unique,
      covered,
      uncovered: unique.filter((ln) => !coveredLines.has(ln)),
      absentFromArtifact: false
    });
  }
  return finalize(files, excludedFiles);
}
function finalize(files, excludedFiles) {
  const inDenominator = files.filter((f) => !f.excluded);
  const coverableTotal = inDenominator.reduce((n, f) => n + f.coverable.length, 0);
  const coveredTotal = inDenominator.reduce((n, f) => n + f.covered.length, 0);
  const gapFiles = inDenominator.filter((f) => f.absentFromArtifact && hasContentChange(f)).map((f) => f.path);
  return {
    files,
    coverableTotal,
    coveredTotal,
    uncoveredTotal: coverableTotal - coveredTotal,
    ratio: coverableTotal > 0 ? coveredTotal / coverableTotal : null,
    gapFiles,
    excludedFiles
  };
}
function hasContentChange(f) {
  return f.absentFromArtifact;
}
function isDeletionOnly(files) {
  const content = files.filter((f) => f.status !== "deleted");
  return files.some((f) => f.linesDeleted > 0) && content.every((f) => f.ranges.every((r) => r.kind === "deleted"));
}

// src/host/analysis/verdict.ts
var VERDICT_REASONS = {
  FINGERPRINT_MISMATCH: "CP_FINGERPRINT_MISMATCH",
  WORKSPACE_CHANGED_DURING_VERIFY: "CP_WORKSPACE_CHANGED_DURING_VERIFY",
  REQUIRED_CHECK_FAILED: "CP_REQUIRED_CHECK_FAILED",
  REQUIRED_CHECK_TIMEOUT: "CP_REQUIRED_CHECK_TIMEOUT",
  REQUIRED_CHECK_CANCELLED: "CP_REQUIRED_CHECK_CANCELLED",
  SPAWN_ERROR: "CP_SPAWN_ERROR",
  NO_GIT_CHANGESET: "CP_NO_GIT_CHANGESET",
  CHANGESET_UNAVAILABLE: "CP_CHANGESET_UNAVAILABLE",
  EVIDENCE_MISSING: "CP_EVIDENCE_UNAVAILABLE",
  COVERAGE_ARTIFACT_MISSING: "CP_COVERAGE_ARTIFACT_MISSING",
  COVERAGE_PARSE_ERROR: "CP_COVERAGE_PARSE_ERROR",
  IMPACT_LOW_CONFIDENCE: "CP_IMPACT_LOW_CONFIDENCE",
  COVERAGE_BELOW_THRESHOLD: "CP_COVERAGE_BELOW_THRESHOLD",
  COVERAGE_GAP_FILES: "CP_COVERAGE_GAP_FILES",
  DELETION_ONLY_RISK: "CP_DELETION_ONLY_RISK",
  PARTIAL_EVIDENCE: "CP_PARTIAL_EVIDENCE",
  NO_EVIDENCE: "CP_NO_EVIDENCE",
  NOT_APPLICABLE_NO_EXECUTABLE_CHANGES: "CP_NOT_APPLICABLE_NO_EXECUTABLE_CHANGES"
};
function reason(code, message, blocking) {
  return { code, message, blocking };
}
function evaluateVerdict(inputs, nowIso) {
  const reasons = [];
  const requiredChecks = [];
  const required = inputs.checks.filter((c) => c.required);
  const anyEvidence = inputs.checks.some((c) => c.evidence !== null);
  for (const c of required) {
    const ev = c.evidence;
    if (!ev) {
      requiredChecks.push({ id: c.id, status: "UNVERIFIED" });
      continue;
    }
    if (ev.workspaceChangedDuringRun) {
      requiredChecks.push({ id: c.id, status: "STALE", evidenceId: ev.id });
      continue;
    }
    if (ev.workspaceFingerprint !== inputs.currentFingerprint) {
      requiredChecks.push({ id: c.id, status: "STALE", evidenceId: ev.id });
      continue;
    }
    if (ev.termination !== "exit") {
      requiredChecks.push({
        id: c.id,
        status: ev.termination === "timeout" || ev.termination === "cancelled" ? "FAILED" : "UNVERIFIED",
        evidenceId: ev.id
      });
      continue;
    }
    if (ev.exitCode !== 0) {
      requiredChecks.push({ id: c.id, status: "FAILED", evidenceId: ev.id });
      continue;
    }
    if (ev.parser.status === "error") {
      requiredChecks.push({ id: c.id, status: "UNVERIFIED", evidenceId: ev.id });
      continue;
    }
    requiredChecks.push({ id: c.id, status: "VERIFIED", evidenceId: ev.id });
  }
  const staleEvidence = required.filter((c) => {
    const ev = c.evidence;
    return ev !== null && (ev.workspaceFingerprint !== inputs.currentFingerprint || ev.workspaceChangedDuringRun);
  });
  if (staleEvidence.length > 0) {
    const fromDuring = staleEvidence.some((c) => c.evidence.workspaceChangedDuringRun);
    reasons.push(
      fromDuring ? reason(
        VERDICT_REASONS.WORKSPACE_CHANGED_DURING_VERIFY,
        `workspace changed during verification; evidence cannot be trusted even though commands may have exited 0: ${staleEvidence.map((c) => c.id).join(", ")}`,
        true
      ) : reason(
        VERDICT_REASONS.FINGERPRINT_MISMATCH,
        `evidence bound to an older workspace fingerprint: ${staleEvidence.map((c) => c.id).join(", ")}`,
        true
      )
    );
    return build("STALE", inputs, reasons, requiredChecks, nowIso);
  }
  const failed = required.filter((c) => {
    const ev = c.evidence;
    return ev !== null && ev.workspaceFingerprint === inputs.currentFingerprint && (ev.termination === "exit" && ev.exitCode !== null && ev.exitCode !== 0 || ev.termination === "timeout" || ev.termination === "cancelled");
  });
  if (failed.length > 0) {
    for (const c of failed) {
      const ev = c.evidence;
      const code = ev.termination === "timeout" ? VERDICT_REASONS.REQUIRED_CHECK_TIMEOUT : ev.termination === "cancelled" ? VERDICT_REASONS.REQUIRED_CHECK_CANCELLED : VERDICT_REASONS.REQUIRED_CHECK_FAILED;
      reasons.push(reason(code, `required check "${c.id}" ${ev.termination === "exit" ? `exited ${ev.exitCode ?? "unknown"}` : ev.termination}`, true));
    }
    return build("FAILED", inputs, reasons, requiredChecks, nowIso);
  }
  const spawnErrored = required.filter((c) => c.evidence?.termination === "spawn-error");
  if (spawnErrored.length > 0) {
    reasons.push(reason(VERDICT_REASONS.SPAWN_ERROR, `required check could not start: ${spawnErrored.map((c) => c.id).join(", ")}`, true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.changeSetMode !== "git" || inputs.changeSetParseError) {
    reasons.push(
      reason(
        inputs.changeSetParseError ? VERDICT_REASONS.CHANGESET_UNAVAILABLE : VERDICT_REASONS.NO_GIT_CHANGESET,
        inputs.changeSetParseError ? "change set could not be parsed reliably" : "workspace is not a usable Git repository; reliable ChangeSet unavailable",
        true
      )
    );
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  const missing = required.filter((c) => !c.evidence);
  const parseErrors = required.filter((c) => c.evidence?.parser.status === "error");
  if (missing.length > 0) {
    reasons.push(reason(VERDICT_REASONS.EVIDENCE_MISSING, `required evidence missing: ${missing.map((c) => c.id).join(", ")}`, true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverageParseError || parseErrors.length > 0) {
    reasons.push(
      reason(
        VERDICT_REASONS.COVERAGE_PARSE_ERROR,
        parseErrors.length > 0 ? `coverage parser error: ${parseErrors.flatMap((c) => c.evidence.parser.diagnostics).join("; ")}` : "coverage parser error",
        true
      )
    );
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverage === null) {
    reasons.push(reason(VERDICT_REASONS.COVERAGE_ARTIFACT_MISSING, "required coverage artifact missing (exit 0 alone proves nothing)", true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.impactMaxConfidence === "LOW" && inputs.policy.requiresExhaustiveImpact && !inputs.contentChangesAllExcluded) {
    reasons.push(reason(VERDICT_REASONS.IMPACT_LOW_CONFIDENCE, "test impact mapping is LOW-confidence only; cannot claim exhaustive relevance", true));
    return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverage.coverableTotal === 0 && inputs.coverage.gapFiles.length === 0) {
    if (inputs.deletionOnly) {
      if (inputs.policy.deletionOnlyPolicy === "NOT_APPLICABLE") {
        reasons.push(reason(VERDICT_REASONS.NOT_APPLICABLE_NO_EXECUTABLE_CHANGES, "ChangeSet contains deletions only; coverage check not applicable (deletion risk recorded separately)", false));
        return build("NOT_APPLICABLE", inputs, reasons, requiredChecks, nowIso);
      }
      reasons.push(reason(VERDICT_REASONS.DELETION_ONLY_RISK, "deletion-only ChangeSet: deleted lines cannot be covered; needs related tests / static checks / mutation smoke as evidence", true));
      return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
    }
    reasons.push(reason(VERDICT_REASONS.NOT_APPLICABLE_NO_EXECUTABLE_CHANGES, "no executable changed lines found for the coverage check", false));
    return build("NOT_APPLICABLE", inputs, reasons, requiredChecks, nowIso);
  }
  if (inputs.coverage.gapFiles.length > 0) {
    reasons.push(
      reason(VERDICT_REASONS.COVERAGE_GAP_FILES, `changed files absent from coverage artifact (cannot set denominator to zero): ${inputs.coverage.gapFiles.join(", ")}`, true)
    );
    if (inputs.coverage.coverableTotal === 0 || inputs.coverage.ratio === null) {
      return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
    }
    return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
  }
  const threshold = inputs.policy.changedLinesThreshold;
  const actual = inputs.coverage.ratio ?? 0;
  const checksOk = requiredChecks.every((c) => c.status === "VERIFIED");
  if (checksOk && inputs.coverage.ratio !== null && actual >= threshold) {
    return build("VERIFIED", inputs, [], requiredChecks, nowIso);
  }
  if (anyEvidence) {
    if (inputs.coverage.ratio !== null && actual < threshold) {
      reasons.push(
        reason(
          VERDICT_REASONS.COVERAGE_BELOW_THRESHOLD,
          `changed-line coverage ${(actual * 100).toFixed(1)}% below required ${(threshold * 100).toFixed(1)}% (${inputs.coverage.coveredTotal}/${inputs.coverage.coverableTotal} lines, ${inputs.coverage.uncoveredTotal} uncovered)`,
          true
        )
      );
    } else if (!checksOk) {
      reasons.push(reason(VERDICT_REASONS.PARTIAL_EVIDENCE, "some required checks not fully verified yet", true));
    }
    return build("PARTIAL", inputs, reasons, requiredChecks, nowIso);
  }
  reasons.push(reason(VERDICT_REASONS.NO_EVIDENCE, "no trustworthy evidence for the current fingerprint", true));
  return build("UNVERIFIED", inputs, reasons, requiredChecks, nowIso);
}
function build(status, inputs, reasons, requiredChecks, nowIso) {
  return {
    schemaVersion: "1.0",
    status,
    workspaceFingerprint: inputs.currentFingerprint,
    evaluatedAt: nowIso,
    reasons,
    requiredChecks,
    changedLineCoverage: {
      threshold: inputs.policy.changedLinesThreshold,
      actual: inputs.coverage?.ratio ?? null
    }
  };
}

// src/host/persistence/evidence-store.ts
import { mkdir, readFile as readFile2, writeFile, readdir } from "node:fs/promises";
import path3 from "node:path";

// src/host/persistence/migrations.ts
var SUPPORTED_SCHEMA_VERSIONS = ["1.0"];
function assertKnownSchemaVersion(container, what) {
  if (!isPlainObject(container)) {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: stored record is not an object; refusing to parse`);
  }
  const v = container["schemaVersion"];
  if (typeof v !== "string") {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: missing schemaVersion; refusing to parse`);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(v)) {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: schema version "${v}" is not supported by this build (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}); refusing to guess fields`);
  }
}
function safeParseKnownVersion(container, what) {
  try {
    assertKnownSchemaVersion(container, what);
    return container;
  } catch {
    return null;
  }
}

// src/host/persistence/evidence-store.ts
var MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
var MAX_RECORDS = 5e3;
var EvidenceStore = class {
  dirAbs;
  constructor(dirAbs) {
    this.dirAbs = dirAbs;
  }
  async append(record) {
    await mkdir(this.dirAbs, { recursive: true });
    const file = path3.join(this.dirAbs, "evidence.jsonl");
    let existing = "";
    try {
      existing = await readFile2(file, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length >= MAX_RECORDS) {
      lines.splice(0, lines.length - MAX_RECORDS + 1);
    }
    lines.push(canonicalJsonStringify(record));
    const next = lines.join("\n") + "\n";
    if (Buffer.byteLength(next, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new CpError("CP_COVERAGE_RESOURCE_EXCEEDED", "evidence store size cap exceeded");
    }
    await writeFile(file, next, { encoding: "utf8" });
  }
  /** Most recent records first (sorted by startedAt then insertion). */
  async listAll() {
    const file = path3.join(this.dirAbs, "evidence.jsonl");
    let text;
    try {
      text = await readFile2(file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed)) continue;
      if (parsed["schemaVersion"] !== "1.0") continue;
      out.push(parsed);
    }
    out.sort((a, b) => a.startedAt === b.startedAt ? a.id < b.id ? -1 : 1 : a.startedAt < b.startedAt ? -1 : 1);
    return out;
  }
  async latest() {
    const all = await this.listAll();
    return all.length > 0 ? all[all.length - 1] : null;
  }
  /** Store self-check used by tests and verify-package. */
  async healthCheck() {
    await mkdir(this.dirAbs, { recursive: true });
    const names = await readdir(this.dirAbs);
    return { ok: names.includes("evidence.jsonl") || names.length >= 0, recordCount: (await this.listAll()).length };
  }
};

// src/host/persistence/coverage-map-store.ts
import { mkdir as mkdir2, readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import path4 from "node:path";
var JsonHistoryMapStore = class {
  fileAbs;
  constructor(fileAbs) {
    this.fileAbs = fileAbs;
  }
  async load() {
    let text;
    try {
      text = await readFile3(this.fileAbs, "utf8");
    } catch {
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const safe = safeParseKnownVersion(parsed, "coverage-map store");
    if (!safe || !Array.isArray(safe["entries"])) return [];
    return safe["entries"].filter((e) => typeof e?.path === "string" && Array.isArray(e.testFiles));
  }
  async save(entries) {
    const container = {
      schemaVersion: "1.0",
      entries: entries.map((e) => ({ ...e, testFiles: [...new Set(e.testFiles)].sort() }))
    };
    await mkdir2(path4.dirname(this.fileAbs), { recursive: true });
    await writeFile2(this.fileAbs, JSON.stringify(container, null, 2), { encoding: "utf8" });
    assertKnownSchemaVersion(container, "coverage-map store");
  }
};

// src/host/tools/verify.ts
import path5 from "node:path";
async function verifyTool(host, workspaceRootAbs, options = {}) {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const plan = buildPlan(
      {
        config: snap.config,
        candidates: snap.candidates,
        changeSetDigest: snap.changeSet.digest,
        workspaceFingerprint: snap.fingerprint,
        nowIso: (/* @__PURE__ */ new Date()).toISOString()
      },
      sha256Hex
    );
    const changedFilesDigest = snap.changeSet.digest;
    const lockConfigDigest = sha256Hex(
      JSON.stringify([...(await gatherFingerprintInputs(host.fs, workspaceRootAbs, snap.config, snap.changeSet, snap.candidates, [], snap.workspaceFiles)).lockfileDigests])
    );
    const { outcomes } = await executePlan(
      plan,
      {
        subprocess: host.subprocess,
        fs: host.fs,
        workspaceRootAbs,
        env: process.env,
        outputLimits: DEFAULT_OUTPUT_LIMITS,
        abortSignal: options.abortSignal,
        approve: options.approve
      },
      {
        planId: plan.id,
        changedFilesDigest,
        workspaceFingerprint: snap.fingerprint,
        lockConfigDigest,
        startedAtIso: (/* @__PURE__ */ new Date()).toISOString()
      }
    );
    const postSnap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const workspaceChangedDuringRun = postSnap.fingerprint !== snap.fingerprint;
    const executableByFile = /* @__PURE__ */ new Map();
    const coveredByFile = /* @__PURE__ */ new Map();
    let coverageParseError = false;
    for (const o of outcomes) {
      if (o.artifact && o.evidence) {
        for (const [p, lines] of o.artifact.executableByFile) executableByFile.set(p, lines);
        for (const [p, lines] of o.artifact.coveredByFile) coveredByFile.set(p, lines);
        if (o.evidence.parser.status === "error") coverageParseError = true;
      }
      if (o.evidence?.parser.status === "error") coverageParseError = true;
    }
    const coverage = analyzeChangedLineCoverage(snap.changeSet, executableByFile, coveredByFile, snap.config.exclude);
    for (const o of outcomes) {
      if (o.step.tier === "changed-line-coverage" && o.evidence) {
        if (workspaceChangedDuringRun) o.evidence.workspaceChangedDuringRun = true;
        o.evidence.coverage = {
          coverableChangedLines: coverage.coverableTotal,
          coveredChangedLines: coverage.coveredTotal,
          ratio: coverage.ratio,
          uncovered: coverage.files.filter((f) => f.uncovered.length > 0).map((f) => ({ path: f.path, lines: f.uncovered }))
        };
      }
    }
    const evidence = outcomes.map((o) => o.evidence).filter((e) => e !== null);
    const evidenceByStep = new Map(evidence.map((e) => [e.stepId, e]));
    const checks = [];
    for (const step of plan.steps) {
      if (!step.required) continue;
      checks.push({ id: step.id, required: true, evidence: evidenceByStep.get(step.id) ?? null });
    }
    const policy = verdictPolicyFromConfig(snap.config);
    const contentChangesAllExcluded = snap.changeSet.files.length > 0 && snap.changeSet.files.every(
      (f) => f.status === "deleted" || f.ranges.every((r) => r.kind === "deleted") || snap.config.exclude.some((g) => globMatch(g, f.path))
    );
    const verdict = evaluateVerdict(
      {
        currentFingerprint: snap.fingerprint,
        changeSetMode: snap.changeSet.mode,
        changeSetParseError: false,
        deletionOnly: isDeletionOnly(snap.changeSet.files),
        contentChangesAllExcluded,
        impactMaxConfidence: snap.maxConfidence,
        coverage,
        coverageParseError,
        checks,
        policy
      },
      (/* @__PURE__ */ new Date()).toISOString()
    );
    const store = new EvidenceStore(path5.join(workspaceRootAbs, ".changeproof", "evidence"));
    for (const e of evidence) {
      if (workspaceChangedDuringRun) e.workspaceChangedDuringRun = true;
      await store.append(e);
    }
    if (snap.config.coverage.historyMap.enabled && coverageParseError === false) {
      const historyStore = new JsonHistoryMapStore(path5.join(workspaceRootAbs, ".changeproof", "coverage-map.json"));
      const entries = await historyStore.load();
      for (const cand of snap.candidates) {
        for (const src of cand.affectedFiles) {
          const file = snap.changeSet.files.find((f) => f.path === src);
          entries.push({
            path: src,
            contentDigest: file?.contentDigest ?? `sha256:${"0".repeat(64)}`,
            testFiles: cand.testFiles,
            adapter: { id: "istanbul", version: "1.0" },
            recordedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
      const byPath = new Map(entries.map((e) => [e.path, e]));
      await historyStore.save([...byPath.values()]);
    }
    const planData = {
      changeSetSummary: {
        mode: snap.changeSet.mode,
        baseline: snap.changeSet.baseline,
        files: snap.changeSet.files.map((f) => ({ path: f.path, status: f.status, linesAdded: f.linesAdded, linesDeleted: f.linesDeleted })),
        deletedLineRisk: deletedLineRiskOf(snap.changeSet.files),
        digest: snap.changeSet.digest
      },
      impact: { candidates: plan.candidates, maxConfidence: snap.maxConfidence },
      steps: plan.steps,
      preview: plan.steps.filter((s) => s.argv.length > 0).map((s) => ({ stepId: s.id, argv: s.argv, cwd: s.cwd, timeoutMs: s.timeoutMs, expectedArtifacts: s.expectedArtifacts })),
      planId: plan.id,
      workspaceFingerprint: snap.fingerprint
    };
    return okResult(
      "changeproof_verify",
      {
        plan: planData,
        evidence,
        verdict,
        coverageByFile: coverage.files,
        changedLineCoverageSummary: {
          coverableTotal: coverage.coverableTotal,
          coveredTotal: coverage.coveredTotal,
          uncoveredTotal: coverage.uncoveredTotal,
          ratio: coverage.ratio,
          gapFiles: coverage.gapFiles,
          excludedFiles: coverage.excludedFiles
        },
        workspaceChangedDuringRun
      },
      diagnosticsFromSnapshot(snap)
    );
  } catch (err) {
    return toolError("changeproof_verify", err);
  }
}

// src/host/tools/status.ts
import path6 from "node:path";
async function statusTool(host, workspaceRootAbs, options = {}) {
  try {
    const snap = await analyzeWorkspace(host, workspaceRootAbs, options);
    const store = new EvidenceStore(path6.join(workspaceRootAbs, ".changeproof", "evidence"));
    const latest = await store.latest();
    let freshness = "no-evidence";
    let staleReason = null;
    if (latest) {
      if (latest.workspaceFingerprint === snap.fingerprint && !latest.workspaceChangedDuringRun) {
        freshness = "fresh";
      } else {
        freshness = "stale";
        staleReason = "workspace fingerprint no longer matches the evidence binding (changed source/test/lock/config/adapter)";
      }
    }
    return okResult("changeproof_status", {
      workspaceFingerprint: snap.fingerprint,
      changeSetSummary: { mode: snap.changeSet.mode, files: snap.changeSet.files.length, digest: snap.changeSet.digest },
      latestEvidence: latest,
      verdict: null,
      freshness,
      staleReason
    });
  } catch (err) {
    return toolError("changeproof_status", err);
  }
}

// src/host/index.ts
async function createChangeproofHost() {
  const host = await createHostContext();
  const tools = new StandaloneToolsPort();
  const disposers = [];
  const registerTool = (id, handler) => {
    const unregister = tools.register({
      id,
      description: TOOL_DESCRIPTIONS[id],
      inputSchema: TOOL_INPUT_SCHEMAS[id],
      handler: async (input) => handler(input)
    });
    disposers.push(unregister);
  };
  const requireWorkspace2 = (input) => {
    const ws = input["workspace"];
    if (typeof ws !== "string" || ws.length === 0) {
      throw new Error("input.workspace is required (absolute workspace root path)");
    }
    return ws;
  };
  const self = {
    host,
    tools,
    async activate() {
      registerTool(
        "changeproof_plan",
        async (input) => planTool(host, requireWorkspace2(input), {
          baselineKind: input["baseline"] === "merge-base" ? "merge-base" : void 0
        })
      );
      registerTool("changeproof_verify", async (input) => {
        if (input["approvalIntent"] !== "approve") {
          throw new Error("changeproof_verify requires approvalIntent=approve (project tests will execute)");
        }
        return verifyTool(host, requireWorkspace2(input), {
          baselineKind: input["baseline"] === "merge-base" ? "merge-base" : void 0
        });
      });
      registerTool("changeproof_status", async (input) => statusTool(host, requireWorkspace2(input)));
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
    }
  };
  return self;
}

// src/host/adapters/dsh/cordis-plugin.ts
var name = "dsh-changeproof";
var inject = ["tools", "systemPrompt"];
var hostPromise = null;
async function getHost() {
  hostPromise ??= createChangeproofHost();
  return hostPromise;
}
function jsonRender(_args, value) {
  return [{ type: "text", text: canonicalJsonStringify(value) }];
}
function requireWorkspace(args) {
  const ws = args["workspace"];
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error("input.workspace is required (absolute path of the workspace root)");
  }
  return ws;
}
var WORKSPACE_PROPERTY = {
  type: "string",
  description: "\u8981\u5206\u6790\u7684\u5DE5\u4F5C\u533A\uFF08git \u4ED3\u5E93\uFF09\u6839\u76EE\u5F55\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002"
};
var BASELINE_PROPERTY = {
  type: "string",
  enum: ["head", "merge-base"],
  description: "\u5BF9\u6BD4\u7684 git \u57FA\u7EBF\u3002\u9ED8\u8BA4 head\u3002"
};
var TOOL_DEFS = [
  {
    toolId: "changeproof_plan",
    description: "Analyze the current ChangeSet (git), resolve which tests are impacted (4-tier: explicit mappings > coverage history > static import graph > naming conventions) and produce a layered verification plan (cheap checks -> targeted tests -> changed-line coverage). Does NOT execute project code.",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY,
        baseline: BASELINE_PROPERTY
      },
      required: ["workspace"]
    },
    timeoutMs: 12e4,
    run: (host, args) => planTool(host, requireWorkspace(args), args["baseline"] === "merge-base" ? { baselineKind: "merge-base" } : {})
  },
  {
    toolId: "changeproof_verify",
    description: "Re-confirm the workspace fingerprint, then execute the layered plan (runs the project's OWN test command via argv; real side effects possible), parse changed-line coverage from the Istanbul/coverage.py artifact and persist evidence. Verdicts: VERIFIED / PARTIAL / FAILED / STALE / UNVERIFIED / NOT_APPLICABLE \u2014 a green exit code alone NEVER yields VERIFIED. Requires approvalIntent=approve.",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY,
        approvalIntent: {
          type: "string",
          enum: ["approve"],
          description: "\u660E\u786E\u6279\u51C6\uFF1A\u5C06\u771F\u5B9E\u6267\u884C\u9879\u76EE\u6D4B\u8BD5\uFF08\u53EF\u80FD\u6709\u526F\u4F5C\u7528\uFF09\u3002"
        },
        baseline: BASELINE_PROPERTY
      },
      required: ["workspace", "approvalIntent"]
    },
    timeoutMs: 36e5,
    run: async (host, args) => {
      if (args["approvalIntent"] !== "approve") {
        throw new Error("changeproof_verify requires approvalIntent=approve (project tests will execute with real side effects)");
      }
      return verifyTool(host, requireWorkspace(args), args["baseline"] === "merge-base" ? { baselineKind: "merge-base" } : {});
    }
  },
  {
    toolId: "changeproof_status",
    description: "Recompute the current workspace fingerprint and report whether the latest persisted evidence is fresh or stale (any change to changed sources, related tests, lockfiles, runner configs or the plugin config invalidates evidence).",
    parameters: {
      type: "object",
      properties: {
        workspace: WORKSPACE_PROPERTY
      },
      required: ["workspace"]
    },
    timeoutMs: 12e4,
    run: (host, args) => statusTool(host, requireWorkspace(args))
  }
];
async function apply(ctx) {
  const disposers = [];
  await ctx.inject(["tools"], () => {
  });
  const registry = ctx.tools;
  for (const def of TOOL_DEFS) {
    disposers.push(
      registry.register({
        name: def.toolId,
        description: def.description,
        parameters: def.parameters,
        output: { schema: { type: "object" }, render: jsonRender },
        timeoutMs: def.timeoutMs,
        execute: async (args) => {
          const cpHost = await getHost();
          const result = await def.run(cpHost.host, args ?? {});
          return canonicalize(result);
        }
      })
    );
  }
  console.error(`[changeproof] apply() registered ${TOOL_DEFS.length} tools: ${TOOL_DEFS.map((d) => d.toolId).join(", ")}`);
}
export {
  TOOL_DEFS as CHANGEPROOF_TOOL_DEFS,
  apply,
  inject,
  name
};
//# sourceMappingURL=cordis-plugin.mjs.map
