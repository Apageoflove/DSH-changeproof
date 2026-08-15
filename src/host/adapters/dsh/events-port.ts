/**
 * 事件端口：只订阅 DSH 的公共事件（tools/post-execute）。
 * standalone 模式没有事件总线，能力报告会明确标注；Client 的新鲜度判断
 * 只依赖规范化工具结果。
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
