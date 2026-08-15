// Deterministic fake test-runner for offline integration/benchmark fixtures.
// usage: node fake-runner.mjs <mode> <coverageOutPath> [srcFile:execLines:coveredLines]
//   modes:
//     pass-with-coverage : exit 0, write an Istanbul coverage-final.json
//     fail               : exit 1 (assertion failure)
//     hang               : sleep forever (timeout testing; spawns a child to test tree kill)
//     no-artifact        : exit 0, write nothing
// coverage spec: <absOrRelSrcFile>:<execLinesCSV>:<coveredCSV>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode = "pass-with-coverage", coveragePath = "", ...specs] = process.argv.slice(2);

if (mode === "pass-with-coverage" && coveragePath) {
  const artifact = {};
  for (const spec of specs) {
    const [file, exec, covered] = spec.split(":");
    const execLines = (exec ?? "").split(",").filter(Boolean).map(Number);
    const coveredLines = new Set((covered ?? "").split(",").filter(Boolean).map(Number));
    const statementMap = {};
    const s = {};
    execLines.forEach((ln, i) => {
      statementMap[String(i)] = { start: { line: ln, column: 0 }, end: { line: ln, column: 20 } };
      s[String(i)] = coveredLines.has(ln) ? 1 : 0;
    });
    artifact[file] = { path: file, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} };
  }
  await mkdir(path.dirname(coveragePath), { recursive: true });
  await writeFile(coveragePath, JSON.stringify(artifact, null, 1), "utf8");
  process.stdout.write(`fake-runner: wrote ${Object.keys(artifact).length} coverage entries\n`);
  process.exit(0);
}

// adversarial artifact modes for the benchmark suite
if (["corrupt-json", "empty-json", "proto-json", "outside-json", "huge-json", "negative-json"].includes(mode) && coveragePath) {
  const mk = (file, statementMap, s) => ({ [file]: { path: file, statementMap, s, fnMap: {}, branchMap: {}, f: {}, b: {} } });
  const loc = (line) => ({ start: { line, column: 0 }, end: { line, column: 20 } });
  let text;
  if (mode === "corrupt-json") text = "{ this is not json !!!";
  else if (mode === "empty-json") text = "{}";
  else if (mode === "proto-json") text = JSON.stringify(mk("__proto__", { "0": loc(2) }, { "0": 1 }));
  else if (mode === "outside-json") text = JSON.stringify(mk("D:/elsewhere/src/mod.ts", { "0": loc(2), "1": loc(3) }, { "0": 1, "1": 1 }));
  else if (mode === "huge-json") text = JSON.stringify(mk("src/mod.ts", { "0": { start: { line: 1 }, end: { line: 900000 } } }, { "0": 1 }));
  else text = JSON.stringify(mk("src/mod.ts", { "0": loc(-5), "1": loc(0) }, { "0": 1, "1": 1 }));
  await mkdir(path.dirname(coveragePath), { recursive: true });
  await writeFile(coveragePath, text, "utf8");
  process.stdout.write(`fake-runner: wrote ${mode} artifact\n`);
  process.exit(0);
}

if (mode === "fail") {
  process.stdout.write("fake-runner: 1 test failed\nassertion error: expected 3 received 4\n");
  process.exit(1);
}

if (mode === "no-artifact") {
  process.stdout.write("fake-runner: all green (no coverage artifact)\n");
  process.exit(0);
}

if (mode === "hang") {
  // child + grandchild to prove process-tree termination
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: false });
  const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true, shell: false });
  void child;
  void grandchild;
  process.stdout.write(`fake-runner: hanging with child=${child.pid} grandchild=${grandchild.pid}\n`);
  setInterval(() => {}, 1000);
}
