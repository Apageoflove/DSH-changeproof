/**
 * DSH seam probe (PROJECT.md 15.3): detects which host capabilities exist at
 * runtime and prints a canonical JSON report. Never throws; every question
 * gets an explicit answer.
 */
import { probeRuntime } from "../src/host/adapters/dsh/capabilities.ts";

const caps = await probeRuntime();
const report = {
  schemaVersion: "1.0",
  probedAt: new Date().toISOString(),
  runtime: caps.runtime,
  dshPackage: caps.dshPackage,
  dshVersion: caps.dshVersion,
  capabilities: {
    tools: caps.tools,
    subprocess: caps.subprocess,
    fs: caps.fs,
    events: caps.events,
    uiSlots: caps.uiSlots
  },
  platform: caps.platform,
  notes: caps.notes
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
