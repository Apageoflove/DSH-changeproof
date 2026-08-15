/**
 * ChangeProof Client entry (loaded by Web profiles via package.json#dsh.client).
 * Registers into official UI slots only (header actions / input dock /
 * details / settings). In standalone (headless) there is no Web host and this
 * entry is not loaded — tools and canonical JSON remain fully functional.
 */
import type { ClientState } from "./projection/freshness-reducer.ts";
import { clientReducer, INITIAL_CLIENT_STATE } from "./projection/freshness-reducer.ts";
import { Proofboard, type ProofboardData } from "./components/Proofboard.tsx";
import { StatusChip } from "./components/StatusChip.tsx";
import { VerifyDock, SettingsSection } from "./components/VerifyDock.tsx";

/** Minimal slot contract a DSH Web host is expected to provide (public seam). */
export interface ClientShell {
  mountHeaderAction(element: unknown): () => void;
  mountInputDock(element: unknown): () => void;
  mountDetails(element: unknown): () => void;
  mountSettings(element: unknown): () => void;
  /** Subscribe to public tool results; returns unsubscribe. */
  onToolResult(listener: (raw: unknown) => void): () => void;
  /** Invoke a host tool by id (same canonical result as the model sees). */
  invokeTool(id: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface ChangeproofClient {
  getState(): ClientState;
  dispose(): void;
}

export function createChangeproofClient(shell: ClientShell, workspaceRoot: string): ChangeproofClient {
  let state: ClientState = INITIAL_CLIENT_STATE;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const l of listeners) l();
  };
  const dispatch = (event: Parameters<typeof clientReducer>[1]) => {
    state = clientReducer(state, event);
    notify();
  };

  const unsubTools = shell.onToolResult((raw) => {
    const kind = (raw as { kind?: string } | null)?.kind ?? "";
    dispatch({ type: kind.startsWith("changeproof_") ? "tool-result" : "mutation-observed", raw, toolId: kind, at: new Date().toISOString() } as never);
  });

  const disposers = [
    unsubTools,
    shell.mountHeaderAction({ render: () => <StatusChip status={state.status ?? "UNVERIFIED"} compact pendingHostConfirmation={state.pendingHostConfirmation} /> }),
    shell.mountInputDock({
      render: () => (
        <VerifyDock
          unverifiedHint={state.status === null || state.status === "UNVERIFIED"}
          onPlan={() => void shell.invokeTool("changeproof_plan", { workspace: workspaceRoot })}
          onVerify={() => void shell.invokeTool("changeproof_verify", { workspace: workspaceRoot, approvalIntent: "approve" })}
        />
      )
    }),
    shell.mountDetails({ render: (data: ProofboardData | null) => <Proofboard state={state} data={data} /> }),
    shell.mountSettings({
      render: (cfg: Parameters<typeof SettingsSection>[0]) => <SettingsSection {...cfg} />
    })
  ];

  return {
    getState: () => state,
    dispose() {
      for (const d of disposers.splice(0)) d();
      listeners.clear();
    }
  };
}

export { clientReducer, INITIAL_CLIENT_STATE };
export type { ClientState };
