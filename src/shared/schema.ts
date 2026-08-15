/**
 * 运行时校验原语 + 规范化 JSON 工具。
 * 手写、零依赖，配置加载和工具入参校验共用。共享代码不 import Node-only 模块。
 */

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue; // undefined values are dropped
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue; // prototype-pollution guard
      }
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** Canonical JSON: sorted keys, no undefined, deterministic (PROJECT.md 8.1). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/** Reject unknown keys: config parsing must fail loud, not silently ignore. */
export function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], ctx: string): string[] {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  return unknown.map((k) => `${ctx}: unknown field "${k}"`);
}

/** Minimal glob-to-RegExp: supports *, **, and literal segments. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` crosses directory boundaries; also swallow a following `/`
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

export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Normalize a workspace-relative path: POSIX separators, no leading "./",
 * reject absolute paths, "..", and Windows device paths (CP_PATH_ESCAPE).
 * Returns null when the path is not a safe workspace-relative path.
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.includes("\0")) return null;
  const p = input.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(p)) return null; // windows drive
  if (/^\/\//.test(p)) return null; // UNC
  if (p.startsWith("/")) return null; // absolute
  if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(p)) return null; // scheme-like / device
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.endsWith(" ") || seg.startsWith(" ")) return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) return null;
    if (WINDOWS_DEVICE_RE.test(seg)) return null; // CON, COM1, NUL.txt, ...
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
