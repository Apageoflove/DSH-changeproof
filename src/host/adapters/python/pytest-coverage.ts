/**
 * pytest runner adapter (pytest + coverage.py JSON).
 * Appends candidate test file paths to the configured pytest argv when it is
 * recognizable; keeps argv unchanged otherwise and records the fact.
 */
import type { PackageConfig } from "../../config/schema.ts";
import type { CoverageAdapter } from "../types.ts";
import { coveragePyAdapter } from "./coverage-json.ts";

export class PytestCoverageAdapter {
  readonly id = "pytest-coverage-json";
  readonly version = "1.0";
  readonly coverageAdapter: CoverageAdapter = coveragePyAdapter;

  buildArgv(configuredArgv: string[], candidateTestFiles: string[]): { argv: string[]; scoped: boolean } {
    const runnerIdx = configuredArgv.findIndex((a) => a === "pytest" || a === "py.test");
    if (runnerIdx === -1 || candidateTestFiles.length === 0) {
      return { argv: [...configuredArgv], scoped: false };
    }
    return { argv: [...configuredArgv, ...candidateTestFiles], scoped: true };
  }

  coverageFileOf(pkg: PackageConfig): string {
    return pkg.test.coverageFile;
  }
}

export const pytestAdapter = new PytestCoverageAdapter();
