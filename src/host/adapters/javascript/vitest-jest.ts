/**
 * Vitest / Jest runner adapter.
 * MVP behavior: run the user-configured package test argv (which must produce
 * the Istanbul artifact). When the argv clearly targets vitest/jest we append
 * the candidate test FILES to scope the run; otherwise we keep the argv
 * unchanged and record a diagnostic that the run was not file-scoped.
 * ChangeProof never installs runners or rewrites project configs.
 */
import type { PackageConfig } from "../../config/schema.ts";
import type { CoverageAdapter } from "../types.ts";
import { istanbulAdapter } from "./istanbul.ts";

export interface RunnerAdapter {
  readonly id: string;
  readonly version: string;
  readonly coverageAdapter: CoverageAdapter;
  /** Absolute-or-configured argv from .changeproof.yml (already validated). */
  buildArgv(configuredArgv: string[], candidateTestFiles: string[]): { argv: string[]; scoped: boolean };
  coverageFileOf(pkg: PackageConfig): string;
}

export class VitestJestAdapter implements RunnerAdapter {
  readonly id: string;
  readonly version = "1.0";
  readonly coverageAdapter = istanbulAdapter;

  constructor(id: "vitest-istanbul" | "jest-istanbul" = "vitest-istanbul") {
    this.id = id;
  }

  buildArgv(configuredArgv: string[], candidateTestFiles: string[]): { argv: string[]; scoped: boolean } {
    const runnerIdx = configuredArgv.findIndex((a) => a === "vitest" || a === "jest");
    if (runnerIdx === -1 || candidateTestFiles.length === 0) {
      return { argv: [...configuredArgv], scoped: false };
    }
    // pass test file paths to the runner directly (paths relative to package cwd
    // are resolved by the runner itself; we pass workspace-relative paths that
    // the planner rewrites to cwd-relative before execution)
    return { argv: [...configuredArgv, ...candidateTestFiles], scoped: true };
  }

  coverageFileOf(pkg: PackageConfig): string {
    return pkg.test.coverageFile;
  }
}

export const vitestAdapter = new VitestJestAdapter("vitest-istanbul");
export const jestAdapter = new VitestJestAdapter("jest-istanbul");
