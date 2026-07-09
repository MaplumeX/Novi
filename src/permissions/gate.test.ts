import { describe, expect, it, vi } from "vitest";
import {
  NonInteractiveApprover,
  PermissionGate,
  SessionPermissionStore,
  createNonInteractivePermissionGate,
} from "./gate.js";
import type { Approver } from "./types.js";

function makeGate(
  tools: Record<string, "allow" | "ask" | "deny">,
  approver: Approver,
  store = new SessionPermissionStore(),
): PermissionGate {
  return new PermissionGate({
    permissions: { tools },
    approver,
    store,
  });
}

describe("SessionPermissionStore", () => {
  it("tracks grants", () => {
    const store = new SessionPermissionStore();
    expect(store.has("bash")).toBe(false);
    store.grant("bash");
    expect(store.has("bash")).toBe(true);
    expect(store.list()).toEqual(["bash"]);
    store.clear();
    expect(store.has("bash")).toBe(false);
  });
});

describe("PermissionGate", () => {
  it("allows tools with allow level without calling approver", async () => {
    const request = vi.fn();
    const gate = makeGate({ read_file: "allow" }, { request });
    const result = await gate.onToolCall({
      toolName: "read_file",
      toolCallId: "1",
      input: { path: "a.ts" },
    });
    expect(result).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("denies tools with deny level without calling approver (AC7)", async () => {
    const request = vi.fn();
    const gate = makeGate({ bash: "deny" }, { request });
    const result = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "ls" },
    });
    expect(result).toEqual({
      block: true,
      reason: "permission denied: bash (deny)",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("asks and allows once without granting session (AC2)", async () => {
    const request = vi.fn().mockResolvedValue("once");
    const store = new SessionPermissionStore();
    const gate = makeGate({ bash: "ask" }, { request }, store);

    const r1 = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "echo 1" },
    });
    expect(r1).toBeUndefined();
    expect(store.has("bash")).toBe(false);

    // Second call asks again.
    const r2 = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "2",
      input: { command: "echo 2" },
    });
    expect(r2).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("asks and grants session so subsequent calls skip ask (AC3)", async () => {
    const request = vi.fn().mockResolvedValue("session");
    const store = new SessionPermissionStore();
    const gate = makeGate({ bash: "ask" }, { request }, store);

    await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "echo 1" },
    });
    expect(store.has("bash")).toBe(true);

    const r2 = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "2",
      input: { command: "echo 2" },
    });
    expect(r2).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("asks and denies with blocked-by-user reason (AC4)", async () => {
    const request = vi.fn().mockResolvedValue("deny");
    const gate = makeGate({ bash: "ask" }, { request });
    const result = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "rm -rf /" },
    });
    expect(result).toEqual({
      block: true,
      reason: "permission denied: bash (blocked by user)",
    });
  });

  it("unlisted tools default to allow", async () => {
    const request = vi.fn();
    const gate = makeGate({ bash: "ask" }, { request });
    const result = await gate.onToolCall({
      toolName: "read_file",
      toolCallId: "1",
      input: {},
    });
    expect(result).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("setPermissions updates policy without clearing store", async () => {
    const request = vi.fn().mockResolvedValue("session");
    const store = new SessionPermissionStore();
    const gate = makeGate({ bash: "ask" }, { request }, store);
    await gate.onToolCall({ toolName: "bash", toolCallId: "1", input: {} });
    expect(store.has("bash")).toBe(true);

    gate.setPermissions({ tools: { bash: "deny" } });
    // Session grant still short-circuits even after policy becomes deny —
    // grants are process-lifetime trust for that tool name (AC13).
    const result = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "2",
      input: {},
    });
    expect(result).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("passes summary to approver for bash command", async () => {
    const request = vi.fn().mockResolvedValue("once");
    const gate = makeGate({ bash: "ask" }, { request });
    await gate.onToolCall({
      toolName: "bash",
      toolCallId: "tc1",
      input: { command: "git status" },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "bash",
        toolCallId: "tc1",
        summary: "command: git status",
      }),
    );
  });
});

describe("NonInteractiveApprover / createNonInteractivePermissionGate", () => {
  it("auto-denies ask with non-interactive reason (AC5)", async () => {
    const store = new SessionPermissionStore();
    const gate = createNonInteractivePermissionGate({
      permissions: { tools: { bash: "ask" } },
      store,
    });
    const result = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "echo hi" },
    });
    expect(result).toEqual({
      block: true,
      reason:
        "permission denied: bash (ask, non-interactive; pass --yes to allow)",
    });
  });

  it("still allows allow-level tools", async () => {
    const gate = createNonInteractivePermissionGate({
      permissions: { tools: { bash: "allow" } },
      store: new SessionPermissionStore(),
    });
    const result = await gate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: {},
    });
    expect(result).toBeUndefined();
  });

  it("NonInteractiveApprover always returns deny", async () => {
    const a = new NonInteractiveApprover();
    await expect(
      a.request({ toolName: "bash", toolCallId: "1", input: {}, summary: "" }),
    ).resolves.toBe("deny");
  });
});
