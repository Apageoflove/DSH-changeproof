/**
 * DSH 绑定层唯一入口（PROJECT.md 15.1, 9.2）。
 * 下游只依赖这里的端口；DSH 接口变化只改这个目录。
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

export async function createHostContext(): Promise<HostContext> {
  const capabilities = await probeRuntime();
  const ports = resolvePorts(capabilities);
  return { capabilities, ...ports };
}

function resolvePorts(_capabilities: Capabilities): HostPorts {
  // 目前用 standalone 端口实现同一契约；将来有真实 ctx 时，
  // 把 ctx.fs / ctx.subprocess / ctx.events 适配到这里（只改这里）。
  return {
    fs: new StandaloneFsPort(),
    subprocess: new StandaloneSubprocessPort(),
    events: new StandaloneEventsPort()
  };
}
