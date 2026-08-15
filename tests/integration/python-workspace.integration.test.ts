import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { createChangeproofHost } from "@host/index.js";
import { cleanup, initRepo, makeTmpDir, writeFiles, projectRoot } from "../helpers/workspace.js";

/**
 * REAL python runner integration: the fixture executes the project-local
 * venv python (.tmp/pyenv) with pytest + coverage.py. The venv lives INSIDE
 * the project directory (hard boundary) and is provisioned by
 * scripts/provision-python-fixture.mjs. When the venv or the tools are
 * absent, this suite SKIPs loudly instead of faking a pass.
 */
const PY = path.join(projectRoot, ".tmp", "pyenv", "Scripts", "python.exe");

function venvReady(): boolean {
  return existsSync(PY);
}

const CONFIG = (py: string) => `
schemaVersion: 1
packages:
  - id: api
    root: ""
    languages: [python]
    include:
      - src/**/*.py
    test:
      adapter: pytest-coverage-json
      argv: ["${py.replace(/\\/g, "/")}", "-m", "pytest", "--cov=src", "--cov-report=json:coverage.json", "-q"]
      cwd: ""
      timeoutMs: 120000
      coverageFile: coverage.json
thresholds:
  changedLines: 1.0
  minimumImpactConfidence: MEDIUM
`;

const CALC_BASE = `def calc(x):
    if x > 0:
        return x + 1
    return x - 1


def unused_branch(x):
    if x == 42:
        return "meaning"
    return None
`;

const TEST_CALC = `from src.calc import calc


def test_calc_positive():
    assert calc(1) == 2


def test_calc_negative():
    assert calc(-1) == -2
`;

let dir: string;
let cp: Awaited<ReturnType<typeof createChangeproofHost>>;

beforeAll(async () => {
  if (!venvReady()) return;
  cp = await createChangeproofHost();
  await cp.activate();
  dir = await makeTmpDir("py-real");
  await initRepo(dir, {
    ".changeproof.yml": CONFIG(PY),
    ".gitignore": "coverage\n__pycache__\n.pytest_cache\n.changeproof\n",
    "src/calc.py": CALC_BASE,
    "tests/__init__.py": "",
    "tests/test_calc.py": TEST_CALC
  });
});

afterAll(async () => {
  if (dir) await cleanup(dir);
  if (cp) cp.dispose();
});

describe.skipIf(!existsSync(PY))("Python workspace with REAL pytest + coverage.py", () => {
  it(
    "verify: real pytest run → real coverage.json → VERIFIED for covered changed lines",
    async () => {
      // THE CHANGE: equivalent rewrite of calc's covered branch (line 3)
      await writeFiles(dir, {
        "src/calc.py": `def calc(x):
    if x > 0:
        return 1 + x
    return x - 1


def unused_branch(x):
    if x == 42:
        return "meaning"
    return None
`
      });
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      expect(res.ok).toBe(true);
      const data = res.data as {
        verdict: { status: string; reasons: { code: string; message: string }[] };
        changedLineCoverageSummary: { coverableTotal: number; coveredTotal: number; ratio: number | null };
        evidence: Array<{ stepId: string; exitCode: number | null; parser: { status: string } }>;
      };
      // line 3 changed (+2): executable & covered by test_calc_positive
      expect(data.verdict.status).toBe("VERIFIED");
      expect(data.changedLineCoverageSummary.coverableTotal).toBeGreaterThan(0);
      expect(data.changedLineCoverageSummary.ratio).toBe(1);
      const parse = data.evidence.find((e) => e.stepId.startsWith("changed-line-coverage"));
      expect(parse!.parser.status).toBe("ok");
    },
    180_000
  );

  it(
    "PARTIAL: changed lines inside the uncovered branch stay uncovered",
    async () => {
      await writeFiles(dir, {
        "src/calc.py": `def calc(x):
    if x > 0:
        return 1 + x
    return x - 1


def unused_branch(x):
    if x == 42:
        return "the-meaning-of-life"
    return None
`
      });
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as {
        verdict: { status: string; reasons: { code: string }[] };
        changedLineCoverageSummary: { uncoveredTotal: number; ratio: number | null };
      };
      expect(data.verdict.status).toBe("PARTIAL");
      expect(data.verdict.reasons.some((r) => r.code === "CP_COVERAGE_BELOW_THRESHOLD")).toBe(true);
      expect(data.changedLineCoverageSummary.uncoveredTotal).toBeGreaterThan(0);
    },
    180_000
  );

  it(
    "FAILED: broken python test (assertion error) via real pytest",
    async () => {
      await writeFiles(dir, {
        "tests/__init__.py": "",
    "tests/test_calc.py": TEST_CALC.replace("assert calc(1) == 2", "assert calc(1) == 999")
      });
      const res = await cp.tools.invoke("changeproof_verify", { workspace: dir, approvalIntent: "approve" });
      const data = res.data as { verdict: { status: string; reasons: { code: string }[] } };
      expect(data.verdict.status).toBe("FAILED");
      expect(data.verdict.reasons.some((r) => r.code === "CP_REQUIRED_CHECK_FAILED")).toBe(true);
      await writeFiles(dir, { "tests/__init__.py": "",
    "tests/test_calc.py": TEST_CALC });
    },
    180_000
  );
});
