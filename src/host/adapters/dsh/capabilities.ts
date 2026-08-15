/**
 * DSH feature probe (PROJECT.md 15.3).
 * The ONLY place that tries to touch real DeepSeek Harness / Cordis modules.
 * When DSH is not installed we fall back to standalone Node capabilities so
 * that headless mode (tools + canonical JSON + state machine) works fully.
 */

export interface Capabilities {
  runtime: "dsh" | "standalone";
  dshPackage: string | null;
  dshVersion: string | null;
  tools: boolean;
  subprocess: boolean;
  fs: boolean;
  events: boolean;
  uiSlots: boolean;
  platform: NodeJS.Platform;
  notes: string[];
}

const DSH_CANDIDATES = ["@deepseek/harness", "deepseek-harness", "cordis"] as const;

async function tryImport(specifier: string): Promise<{ version: string } | null> {
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    const version =
      typeof mod.VERSION === "string"
        ? mod.VERSION
        : typeof mod.version === "string"
          ? mod.version
          : "unknown";
    return { version };
  } catch {
    return null;
  }
}

/**
 * Probe the runtime for DSH seams. Never throws: unknown runtime degrades to
 * standalone capabilities which are documented in the report notes.
 */
export async function probeRuntime(): Promise<Capabilities> {
  const notes: string[] = [];
  let dshPackage: string | null = null;
  let dshVersion: string | null = null;

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
    tools: true, // standalone registry provides the same registration contract
    subprocess: true, // standalone port over node:child_process
    fs: true, // standalone port over node:fs
    events: runtime === "dsh", // public tools/post-execute events only exist under DSH
    uiSlots: false, // Web slots are optional and only exist in a Web profile
    platform: process.platform,
    notes
  };
}
