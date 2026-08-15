/**
 * Compatibility Facade (PROJECT.md 15.1, 9.2).
 * The single place where DSH bindings exist. Everything downstream consumes
 * these ports; DSH breaking changes are absorbed here.
 */
import type { Capabilities } from "./capabilities.ts";
import { probeRuntime } from "./capabilities.ts";
import { StandaloneEventsPort, type EventsPort } from "./events-port.ts";
import { StandaloneFsPort, type FsPort } from "./fs-port.ts";
import { StandaloneSubprocessPort, type SubprocessPort } from "./subprocess-port.ts";

export interface HostContext {
  capabilities: Capabilities;
  fs: FsPort;
  subprocess: SubprocessPort;
  events: EventsPort;
}

export interface HostPorts {
  fs: FsPort;
  subprocess: SubprocessPort;
  events: EventsPort;
}

/**
 * Build the host context. When a real DSH plugin ctx is provided (future
 * integration), its public capabilities are adapted into our ports here;
 * otherwise standalone ports are used. All DSH-specific types live in this
 * directory and nowhere else.
 */
export async function createHostContext(): Promise<HostContext> {
  const capabilities = await probeRuntime();
  const ports = resolvePorts(capabilities);
  return { capabilities, ...ports };
}

function resolvePorts(_capabilities: Capabilities): HostPorts {
  // Standalone ports implement the same contract a DSH host would inject.
  // When a real ctx is available, adapters mapping ctx.fs / ctx.subprocess /
  // ctx.events onto these interfaces are added HERE (and only here).
  return {
    fs: new StandaloneFsPort(),
    subprocess: new StandaloneSubprocessPort(),
    events: new StandaloneEventsPort()
  };
}
