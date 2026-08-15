import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { createChangeproofClient } from "@client/index.js";
import { StatusChip } from "@client/components/StatusChip.js";
import { okResult } from "@shared/result.js";

/**
 * Web-profile E2E (static projection): a real DSH Web host is not installed
 * on this machine, so the Client is driven through the PUBLIC ClientShell
 * contract and server-rendered. This is a projection smoke test, NOT the
 * real in-app Web E2E — that gate stays UNVERIFIED until a pinned DSH Web
 * profile exists (documented in docs/compatibility.md).
 */
function makeShell() {
  const header: Array<{ render: (data?: unknown) => unknown }> = [];
  const dock: Array<{ render: (data?: unknown) => unknown }> = [];
  const details: Array<{ render: (data?: unknown) => unknown }> = [];
  const settings: Array<{ render: (data?: unknown) => unknown }> = [];
  const invocations: Array<{ id: string; input: Record<string, unknown> }> = [];
  const mounts = { header, dock, details, settings, invocations };
  const toolResults: Array<(raw: unknown) => void> = [];
  return {
    mounts,
    shell: {
      mountHeaderAction(el: never) {
        mounts.header.push(el);
        return () => mounts.header.pop();
      },
      mountInputDock(el: never) {
        mounts.dock.push(el);
        return () => mounts.dock.pop();
      },
      mountDetails(el: never) {
        mounts.details.push(el);
        return () => mounts.details.pop();
      },
      mountSettings(el: never) {
        mounts.settings.push(el);
        return () => mounts.settings.pop();
      },
      onToolResult(listener: (raw: unknown) => void) {
        toolResults.push(listener);
        return () => toolResults.splice(toolResults.indexOf(listener), 1);
      },
      async invokeTool(id: string, input: Record<string, unknown>) {
        invocations.push({ id, input });
        return okResult("changeproof_plan", {});
      }
    },
    emit(raw: unknown) {
      for (const l of toolResults) l(raw);
    }
  };
}

describe("web client E2E (public ClientShell contract)", () => {
  it("mounts into all four official slots and cleans up on dispose (no residue)", () => {
    const env = makeShell();
    const client = createChangeproofClient(env.shell, "/ws");
    expect(env.mounts.header).toHaveLength(1);
    expect(env.mounts.dock).toHaveLength(1);
    expect(env.mounts.details).toHaveLength(1);
    expect(env.mounts.settings).toHaveLength(1);
    client.dispose();
    expect(env.mounts.header).toHaveLength(0);
    expect(env.mounts.dock).toHaveLength(0);
    expect(env.mounts.details).toHaveLength(0);
    expect(env.mounts.settings).toHaveLength(0);
  });

  it("a changeproof_verify result updates state; a write-tool result conservatively marks STALE", () => {
    const env = makeShell();
    const client = createChangeproofClient(env.shell, "/ws");
    env.emit(
      okResult("changeproof_verify", {
        verdict: { status: "VERIFIED", evaluatedAt: "2026-08-14T00:00:00Z", reasons: [], requiredChecks: [], changedLineCoverage: { threshold: 1, actual: 1 } },
        changedLineCoverageSummary: { coverableTotal: 3, coveredTotal: 3, uncoveredTotal: 0, ratio: 1, gapFiles: [], excludedFiles: [] }
      })
    );
    expect(client.getState().status).toBe("VERIFIED");
    env.emit({ schemaVersion: "1.0", kind: "fs_write_file", ok: true, data: {}, diagnostics: [] });
    const s = client.getState();
    expect(s.status).toBe("STALE");
    expect(s.pendingHostConfirmation).toBe(true);
    client.dispose();
  });

  it("dock actions invoke host tools through the public seam", async () => {
    const env = makeShell();
    const client = createChangeproofClient(env.shell, "/ws");
    const dock = env.mounts.dock[0]! as unknown as { render: () => { props: { onPlan: () => void; onVerify: () => void } } };
    dock.render().props.onPlan();
    dock.render().props.onVerify();
    await Promise.resolve();
    const invocations = env.mounts.invocations;
    expect(invocations.map((i) => i.id)).toEqual(["changeproof_plan", "changeproof_verify"]);
    expect(invocations[1]!.input["approvalIntent"]).toBe("approve");
    client.dispose();
  });

  it("header slot renders a server-renderable status chip", () => {
    const html = renderToStaticMarkup(h(StatusChip, { status: "VERIFIED" }));
    expect(html).toContain("已验证");
  });
});
