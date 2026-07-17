import { describe, expect, it, vi } from "vitest";
import { TuiApprover } from "./tui-approver.js";
import type { ApprovalRequest } from "./types.js";

function request(toolCallId: string, summary: string): ApprovalRequest {
  return {
    toolName: "bash",
    toolCallId,
    input: { command: summary },
    summary,
    capability: "shell.execute",
    target: summary,
    scope: "command",
    reason: "confirmation required",
    intents: [],
    shellBoundaryWarning: true,
    sessionGrantAvailable: true,
  };
}

describe("TuiApprover", () => {
  it("queues concurrent requests and resolves in order", async () => {
    const a = new TuiApprover();
    const p1 = a.request(request("1", "cmd1"));
    const p2 = a.request(request("2", "cmd2"));

    expect(a.currentPrompt()?.toolCallId).toBe("1");
    a.respond("once");
    await expect(p1).resolves.toBe("once");

    expect(a.currentPrompt()?.toolCallId).toBe("2");
    a.respond("session");
    await expect(p2).resolves.toBe("session");
    expect(a.currentPrompt()).toBeNull();
  });

  it("denyAll resolves active and queued as deny", async () => {
    const a = new TuiApprover();
    const p1 = a.request(request("1", "a"));
    const p2 = a.request(request("2", "b"));
    a.denyAll();
    await expect(p1).resolves.toBe("deny");
    await expect(p2).resolves.toBe("deny");
    expect(a.currentPrompt()).toBeNull();
  });

  it("notifies subscribers", () => {
    const a = new TuiApprover();
    const listener = vi.fn();
    a.subscribe(listener);
    // Immediate emit of null
    expect(listener).toHaveBeenCalledWith(null);

    void a.request(request("1", "x"));
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "bash", summary: "x" }),
    );

    a.respond("deny");
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it("denies one child run without disturbing parent or other child requests", async () => {
    const a = new TuiApprover();
    const childOne = a.request({
      ...request("1", "child-one"),
      source: { kind: "agent-run", runId: "run_1", profile: "worker" },
    });
    const parent = a.request({ ...request("2", "parent"), source: { kind: "parent" } });
    const childTwo = a.request({
      ...request("3", "child-two"),
      source: { kind: "agent-run", runId: "run_2", profile: "worker" },
    });

    a.denyForRun("run_1");
    await expect(childOne).resolves.toBe("deny");
    expect(a.currentPrompt()?.toolCallId).toBe("2");
    a.respond("once");
    await expect(parent).resolves.toBe("once");
    expect(a.currentPrompt()?.source).toMatchObject({ kind: "agent-run", runId: "run_2" });
    a.respond("deny");
    await expect(childTwo).resolves.toBe("deny");
  });

  it("projects the real external source and bounded effective input", () => {
    const approver = new TuiApprover();
    void approver.request({
      ...request("mcp", "invoke"),
      toolName: "mcp_demo_read",
      input: { path: "/work/report.txt" },
      toolSource: { kind: "external", id: "mcp:demo" },
    });
    expect(approver.currentPrompt()).toMatchObject({
      toolName: "mcp_demo_read",
      toolSource: { kind: "external", id: "mcp:demo" },
      inputPreview: '{"path":"/work/report.txt"}',
    });
    approver.respond("deny");
  });
});
