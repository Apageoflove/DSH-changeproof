/**
 * Versioned persistence: migrations gate unknown schema versions (read-only
 * refusal, never a guess; PROJECT.md 19.3).
 */
import { CpError } from "../../shared/errors.ts";
import { isPlainObject } from "../../shared/schema.ts";

export const CURRENT_SCHEMA_VERSION = "1.0";
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0"] as const;

export function assertKnownSchemaVersion(container: unknown, what: string): void {
  if (!isPlainObject(container)) {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: stored record is not an object; refusing to parse`);
  }
  const v = container["schemaVersion"];
  if (typeof v !== "string") {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: missing schemaVersion; refusing to parse`);
  }
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(v)) {
    throw new CpError("CP_SCHEMA_VERSION_UNSUPPORTED", `${what}: schema version "${v}" is not supported by this build (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}); refusing to guess fields`);
  }
}

/** Read-only downgrade: unknown versions return null instead of throwing. */
export function safeParseKnownVersion(container: unknown, what: string): Record<string, unknown> | null {
  try {
    assertKnownSchemaVersion(container, what);
    return container as Record<string, unknown>;
  } catch {
    return null;
  }
}
