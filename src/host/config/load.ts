/**
 * Config loader: read `.changeproof.yml` from the workspace, parse strictly,
 * fail loud on any problem. The plugin NEVER writes this file or any
 * project/lockfile.
 */
import { CpError } from "../../shared/errors.ts";
import type { FsPort } from "../adapters/dsh/fs-port.ts";
import { DEFAULT_CONFIG_PATH } from "./defaults.ts";
import { validateConfig, type ChangeProofConfig } from "./schema.ts";

export type { ChangeProofConfig };

const MAX_CONFIG_BYTES = 512 * 1024;

export async function loadConfig(fs: FsPort, workspaceRootAbs: string, relPath: string = DEFAULT_CONFIG_PATH): Promise<ChangeProofConfig> {
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
  let parsed: unknown;
  try {
    const { parse } = await import("yaml");
    parsed = parse(text, { strict: false });
  } catch (err) {
    throw new CpError("CP_CONFIG_INVALID", `${relPath}: YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateConfig(parsed, relPath);
}
