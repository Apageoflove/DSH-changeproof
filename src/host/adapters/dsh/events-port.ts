/**
 * Events port: subscription to PUBLIC DSH events only (tools/post-execute).
 * Standalone mode exposes no events; the capability report makes that
 * explicit and the Client freshness reducer then relies on canonical
 * tool results only.
 */

export interface DshToolResultEvent {
  toolId: string;
  ok: boolean;
  /** True when the tool plausibly mutated workspace files (write/edit class). */
  mutationLikely: boolean;
  at: string;
}

export type ToolResultListener = (event: DshToolResultEvent) => void;

export interface EventsPort {
  readonly available: boolean;
  /** Returns an unsubscribe function (Cordis-effect compatible cleanup). */
  onToolResult(listener: ToolResultListener): () => void;
}

export class StandaloneEventsPort implements EventsPort {
  readonly available = false;
  private listeners = new Set<ToolResultListener>();

  onToolResult(listener: ToolResultListener): () => void {
    // Standalone: no DSH event bus exists; kept for interface symmetry.
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Used by the standalone CLI to feed observed tool results (tests use it too). */
  emit(event: DshToolResultEvent): void {
    for (const l of this.listeners) l(event);
  }
}
