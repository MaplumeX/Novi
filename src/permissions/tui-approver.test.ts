import { describe, expect, it, vi } from "vitest";
import { TuiApprover } from "./tui-approver.js";

describe("TuiApprover", () => {
  it("queues concurrent requests and resolves in order", async () => {
    const a = new TuiApprover();
    const p1 = a.request({
      toolName: "bash",
      toolCallId: "1",
      input: {},
      summary: "cmd1",
    });
    const p2 = a.request({
      toolName: "bash",
      toolCallId: "2",
      input: {},
      summary: "cmd2",
    });

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
    const p1 = a.request({
      toolName: "bash",
      toolCallId: "1",
      input: {},
      summary: "a",
    });
    const p2 = a.request({
      toolName: "bash",
      toolCallId: "2",
      input: {},
      summary: "b",
    });
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

    void a.request({
      toolName: "bash",
      toolCallId: "1",
      input: {},
      summary: "x",
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "bash", summary: "x" }),
    );

    a.respond("deny");
    expect(listener).toHaveBeenLastCalledWith(null);
  });
});
