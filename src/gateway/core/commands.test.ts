import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry, runCommand } from "./commands.js";
import { GatewaySessionManager } from "./session-manager.js";
import type { AgentProtocolAdapter, ChannelAdapter, GatewaySessionRoute } from "./types.js";

function agent(): AgentProtocolAdapter {
  return {
    runTurn: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    resetSession: vi.fn().mockResolvedValue(undefined),
    appendScheduledDelivery: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn(),
    stop: vi.fn(),
  };
}

function channel(): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct"] },
    textChunkLimit: 4096,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

const route: GatewaySessionRoute = {
  key: "gateway:telegram:primary:direct:chat-1",
  locator: {
    channel: "telegram",
    account: "primary",
    chat: { type: "direct", id: "chat-1" },
  },
};

function manager(adapter: AgentProtocolAdapter): GatewaySessionManager {
  return new GatewaySessionManager({
    agent: adapter,
    idleTimeoutMs: 1000,
    maxConcurrentSessions: 10,
    queueMode: "steer",
  });
}

describe("gateway /new command", () => {
  it("acknowledges only after the manager reset succeeds", async () => {
    const adapter = agent();
    const sessions = manager(adapter);
    const reset = vi.spyOn(sessions, "reset").mockResolvedValue(undefined);
    const outbound = channel();
    expect(
      await runCommand(
        outbound,
        route,
        { chatId: "chat-1" },
        "/new",
        adapter,
        sessions,
        createCommandRegistry(),
      ),
    ).toBe(true);
    expect(reset).toHaveBeenCalledWith(route);
    expect(outbound.send).toHaveBeenCalledWith({ chatId: "chat-1" }, "Started a fresh session.");
  });

  it("surfaces reset persistence failures to the channel", async () => {
    const adapter = agent();
    const sessions = manager(adapter);
    vi.spyOn(sessions, "reset").mockRejectedValue(new Error("disk full"));
    const outbound = channel();
    await runCommand(
      outbound,
      route,
      { chatId: "chat-1" },
      "/new",
      adapter,
      sessions,
      createCommandRegistry(),
    );
    expect(outbound.send).toHaveBeenCalledWith(
      { chatId: "chat-1" },
      expect.stringContaining("disk full"),
    );
    expect(outbound.send).not.toHaveBeenCalledWith(
      { chatId: "chat-1" },
      "Started a fresh session.",
    );
  });
});
