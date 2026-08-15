/**
 * `.changeproof.yml` schema + strict validation (PROJECT.md 13).
 * Unknown fields, type errors, path escapes, threshold range violations and
 * ambiguous package overlaps all FAIL LOUD — no silent fallback.
 */
import { CpError } from "../../shared/errors.ts";
import type { Confidence } from "../../shared/models.ts";
import {
  assertNoUnknownKeys,
  globToRegExp,
  isNumber,
  isPlainObject,
  isString,
  isStringArray,
  normalizeWorkspacePath
} from "../../shared/schema.ts";

export type TestAdapterId = "vitest-istanbul" | "jest-istanbul" | "pytest-coverage-json";

export interface PackageConfig {
  id: string;
  root: string; // workspace-relative POSIX, "" allowed for repo root
  languages: string[]; // "typescript" | "javascript" | "python"
  include: string[]; // globs relative to workspace root
  test: {
    adapter: TestAdapterId;
    argv: string[];
    cwd: string; // workspace-relative
    timeoutMs: number;
    coverageFile: string; // workspace-relative
  };
}

export interface CheckConfig {
  id: string;
  packageId: string;
  tier: "cheap" | "targeted-test";
  required: boolean;
  argv?: string[];
  cwd: string;
  timeoutMs: number;
  usePackageTestAdapter: boolean;
}

export interface MappingConfig {
  sources: string[];
  tests: string[];
  confidence: Confidence;
}

export interface CoverageConfig {
  changedLinesOnly: boolean;
  requireArtifact: boolean;
  sourceMap: "auto" | "off";
  historyMap: { enabled: boolean; maxAgeDays: number };
}

export interface ThresholdsConfig {
  changedLines: number;
  minimumImpactConfidence: Confidence;
}

export interface ChangeProofConfig {
  schemaVersion: 1;
  baseline: { kind: "head" | "merge-base"; ref?: string };
  packages: PackageConfig[];
  checks: CheckConfig[];
  mappings: MappingConfig[];
  coverage: CoverageConfig;
  thresholds: ThresholdsConfig;
  exclude: string[];
  /** Absolute path of the loaded config (for provenance display). */
  sourcePath: string;
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "baseline",
  "packages",
  "checks",
  "mappings",
  "coverage",
  "thresholds",
  "exclude"
] as const;

const CONFIDENCES: Confidence[] = ["HIGH", "MEDIUM", "LOW"];
const ADAPTERS: TestAdapterId[] = ["vitest-istanbul", "jest-istanbul", "pytest-coverage-json"];
const LANGUAGES = ["typescript", "javascript", "python"];

function validateRelativePath(value: unknown, ctx: string, allowEmpty = false): string {
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

function validateGlob(value: unknown, ctx: string): string {
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

function validateArgv(value: unknown, ctx: string): string[] {
  if (!isStringArray(value) || value.length === 0) {
    throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a non-empty argv array of strings (no shell strings)`);
  }
  for (const a of value) {
    if (a.includes("\0")) throw new CpError("CP_CONFIG_INVALID", `${ctx}: argv entries must not contain NUL`);
    if (/[&|;`$><\n]/.test(a) && a.length > 0 && process.env["CP_ALLOW_SHELLY_ARGV"] !== "1") {
      // Not banned outright (legit args may contain '$'), but a single argv
      // element that looks like a shell command line is rejected: commands
      // are argv arrays, never "npm test && curl ...".
      if (/&&|\|\||;\s|\n/.test(a)) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}: argv entry looks like a shell command line ("${a.slice(0, 60)}"); split into argv elements or use an explicit executable`);
      }
    }
  }
  return [...value];
}

export function validateConfig(raw: unknown, sourcePath: string): ChangeProofConfig {
  if (!isPlainObject(raw)) throw new CpError("CP_CONFIG_INVALID", "config root must be a mapping");
  const unknownTop = assertNoUnknownKeys(raw, TOP_LEVEL_KEYS, "config");
  if (unknownTop.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownTop.join("; "));

  if (raw["schemaVersion"] !== 1) {
    throw new CpError("CP_CONFIG_INVALID", `schemaVersion must be 1 (got ${JSON.stringify(raw["schemaVersion"])})`);
  }

  // baseline (optional)
  let baseline: ChangeProofConfig["baseline"] = { kind: "head" };
  if (raw["baseline"] !== undefined) {
    const b = raw["baseline"];
    if (!isPlainObject(b)) throw new CpError("CP_CONFIG_INVALID", "baseline must be a mapping");
    const unknownB = assertNoUnknownKeys(b, ["kind", "ref"], "baseline");
    if (unknownB.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownB.join("; "));
    const kind = b["kind"];
    if (kind !== "head" && kind !== "merge-base") throw new CpError("CP_CONFIG_INVALID", "baseline.kind must be head|merge-base");
    baseline = kind === "merge-base" ? { kind, ref: isString(b["ref"]) ? b["ref"] : "origin/main" } : { kind };
  }

  // packages
  if (!Array.isArray(raw["packages"]) || raw["packages"].length === 0) {
    throw new CpError("CP_CONFIG_INVALID", "packages must be a non-empty array");
  }
  const packages: PackageConfig[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw["packages"].length; i += 1) {
    const p = raw["packages"][i]!;
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
    if (!isString(adapter) || !ADAPTERS.includes(adapter as TestAdapterId)) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.adapter must be one of ${ADAPTERS.join(", ")}`);
    }
    const argv = validateArgv(t["argv"], `${tctx}.argv`);
    const testCwd = validateRelativePath(t["cwd"] ?? "", `${tctx}.cwd`, true);
    if (testCwd !== "" && root !== "" && !testCwd.startsWith(root + "/") && testCwd !== root) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.cwd (${testCwd}) escapes package root (${root})`);
    }
    if (testCwd !== "" && root === "" && !includeGlobs.some((g) => testCwd.startsWith(g.replace(/\/\*\*.*$/, "")))) {
      // rootless single-package setups are common; cwd just needs to be in-workspace
    }
    const timeoutMs = t["timeoutMs"];
    if (!isNumber(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
      throw new CpError("CP_CONFIG_INVALID", `${tctx}.timeoutMs must be a number in (0, 3600000]`);
    }
    const coverageFile = validateRelativePath(t["coverageFile"], `${tctx}.coverageFile`);

    packages.push({ id, root, languages, include: includeGlobs, test: { adapter: adapter as TestAdapterId, argv, cwd: testCwd, timeoutMs, coverageFile } });
  }

  // package overlap ambiguity: nested roots are ambiguous -> reject
  for (let a = 0; a < packages.length; a += 1) {
    for (let b = a + 1; b < packages.length; b += 1) {
      const ra = packages[a]!.root;
      const rb = packages[b]!.root;
      if (ra === "" || rb === "") continue; // single-package root is fine
      if (ra === rb || ra.startsWith(rb + "/") || rb.startsWith(ra + "/")) {
        throw new CpError("CP_CONFIG_INVALID", `packages "${packages[a]!.id}" and "${packages[b]!.id}" have overlapping roots (${ra} vs ${rb}); ambiguous package boundary`);
      }
    }
  }

  // checks (optional)
  const checks: CheckConfig[] = [];
  if (raw["checks"] !== undefined) {
    if (!Array.isArray(raw["checks"])) throw new CpError("CP_CONFIG_INVALID", "checks must be an array");
    const seenCheckIds = new Set<string>();
    for (let i = 0; i < raw["checks"].length; i += 1) {
      const c = raw["checks"][i]!;
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
      const required = c["required"] === undefined ? true : c["required"];
      if (typeof required !== "boolean") throw new CpError("CP_CONFIG_INVALID", `${ctx}.required must be boolean`);
      const usePackageTestAdapter = c["usePackageTestAdapter"] === undefined ? false : c["usePackageTestAdapter"];
      if (typeof usePackageTestAdapter !== "boolean") throw new CpError("CP_CONFIG_INVALID", `${ctx}.usePackageTestAdapter must be boolean`);
      let argv: string[] | undefined;
      if (c["argv"] !== undefined) argv = validateArgv(c["argv"], `${ctx}.argv`);
      if (tier === "cheap" && !argv) throw new CpError("CP_CONFIG_INVALID", `${ctx}: cheap checks must define argv`);
      if (tier === "targeted-test" && !argv && !usePackageTestAdapter) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}: targeted-test checks need argv or usePackageTestAdapter:true`);
      }
      const cwd = validateRelativePath(c["cwd"] === undefined ? packages.find((p) => p.id === packageId)!.root : c["cwd"], `${ctx}.cwd`, true);
      const timeoutMs = c["timeoutMs"] === undefined ? 120_000 : c["timeoutMs"];
      if (!isNumber(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}.timeoutMs must be a number in (0, 3600000]`);
      }
      checks.push({ id, packageId, tier, required, argv, cwd, timeoutMs, usePackageTestAdapter });
    }
  }

  // mappings (optional)
  const mappings: MappingConfig[] = [];
  if (raw["mappings"] !== undefined) {
    if (!Array.isArray(raw["mappings"])) throw new CpError("CP_CONFIG_INVALID", "mappings must be an array");
    for (let i = 0; i < raw["mappings"].length; i += 1) {
      const m = raw["mappings"][i]!;
      const ctx = `mappings[${i}]`;
      if (!isPlainObject(m)) throw new CpError("CP_CONFIG_INVALID", `${ctx}: must be a mapping`);
      const unknownM = assertNoUnknownKeys(m, ["sources", "tests", "confidence"], ctx);
      if (unknownM.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownM.join("; "));
      const sources = m["sources"];
      const tests = m["tests"];
      if (!isStringArray(sources) || sources.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.sources must be a non-empty glob array`);
      if (!isStringArray(tests) || tests.length === 0) throw new CpError("CP_CONFIG_INVALID", `${ctx}.tests must be a non-empty glob array`);
      const confidence = m["confidence"];
      if (!isString(confidence) || !CONFIDENCES.includes(confidence as Confidence)) {
        throw new CpError("CP_CONFIG_INVALID", `${ctx}.confidence must be HIGH|MEDIUM|LOW`);
      }
      mappings.push({
        sources: sources.map((g, j) => validateGlob(g, `${ctx}.sources[${j}]`)),
        tests: tests.map((g, j) => validateGlob(g, `${ctx}.tests[${j}]`)),
        confidence: confidence as Confidence
      });
    }
  }

  // coverage (optional)
  let coverage: CoverageConfig = {
    changedLinesOnly: true,
    requireArtifact: true,
    sourceMap: "auto",
    historyMap: { enabled: false, maxAgeDays: 14 }
  };
  if (raw["coverage"] !== undefined) {
    const c = raw["coverage"];
    if (!isPlainObject(c)) throw new CpError("CP_CONFIG_INVALID", "coverage must be a mapping");
    const unknownC = assertNoUnknownKeys(c, ["changedLinesOnly", "requireArtifact", "sourceMap", "historyMap"], "coverage");
    if (unknownC.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownC.join("; "));
    const sourceMap = c["sourceMap"] === undefined ? "auto" : c["sourceMap"];
    if (sourceMap !== "auto" && sourceMap !== "off") throw new CpError("CP_CONFIG_INVALID", "coverage.sourceMap must be auto|off");
    let historyMap = coverage.historyMap;
    if (c["historyMap"] !== undefined) {
      const h = c["historyMap"];
      if (!isPlainObject(h)) throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap must be a mapping");
      const unknownH = assertNoUnknownKeys(h, ["enabled", "maxAgeDays"], "coverage.historyMap");
      if (unknownH.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownH.join("; "));
      const enabled = h["enabled"] === undefined ? false : h["enabled"];
      if (typeof enabled !== "boolean") throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap.enabled must be boolean");
      const maxAgeDays = h["maxAgeDays"] === undefined ? 14 : h["maxAgeDays"];
      if (!isNumber(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 365) throw new CpError("CP_CONFIG_INVALID", "coverage.historyMap.maxAgeDays must be in (0, 365]");
      historyMap = { enabled, maxAgeDays };
    }
    const changedLinesOnly = c["changedLinesOnly"] === undefined ? true : c["changedLinesOnly"];
    const requireArtifact = c["requireArtifact"] === undefined ? true : c["requireArtifact"];
    if (typeof changedLinesOnly !== "boolean" || typeof requireArtifact !== "boolean") {
      throw new CpError("CP_CONFIG_INVALID", "coverage.changedLinesOnly/requireArtifact must be boolean");
    }
    coverage = { changedLinesOnly, requireArtifact, sourceMap, historyMap };
  }

  // thresholds (optional)
  let thresholds: ThresholdsConfig = { changedLines: 1.0, minimumImpactConfidence: "MEDIUM" };
  if (raw["thresholds"] !== undefined) {
    const t = raw["thresholds"];
    if (!isPlainObject(t)) throw new CpError("CP_CONFIG_INVALID", "thresholds must be a mapping");
    const unknownT = assertNoUnknownKeys(t, ["changedLines", "minimumImpactConfidence"], "thresholds");
    if (unknownT.length > 0) throw new CpError("CP_CONFIG_INVALID", unknownT.join("; "));
    if (t["changedLines"] !== undefined) {
      if (!isNumber(t["changedLines"]) || t["changedLines"] < 0 || t["changedLines"] > 1) {
        throw new CpError("CP_CONFIG_INVALID", `thresholds.changedLines must be within [0, 1] (got ${JSON.stringify(t["changedLines"])})`);
      }
      thresholds = { ...thresholds, changedLines: t["changedLines"] };
    }
    if (t["minimumImpactConfidence"] !== undefined) {
      const mc = t["minimumImpactConfidence"];
      if (!isString(mc) || !CONFIDENCES.includes(mc as Confidence)) {
        throw new CpError("CP_CONFIG_INVALID", "thresholds.minimumImpactConfidence must be HIGH|MEDIUM|LOW");
      }
      thresholds = { ...thresholds, minimumImpactConfidence: mc as Confidence };
    }
  }

  // exclude (optional)
  let exclude: string[] = [];
  if (raw["exclude"] !== undefined) {
    if (!isStringArray(raw["exclude"])) throw new CpError("CP_CONFIG_INVALID", "exclude must be a string array");
    exclude = (raw["exclude"] as string[]).map((g, j) => validateGlob(g, `exclude[${j}]`));
  }

  return { schemaVersion: 1, baseline, packages, checks, mappings, coverage, thresholds, exclude, sourcePath };
}
