import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewaySessionManager } from "./session-manager.js";
import type { AgentProtocolAdapter, ChannelAdapter, ChannelMessage } from "./types.js";

function route(key: string) {
  return {
    key,
    locator: {
      channel: "telegram" as const,
      account: "tg",
      chat: { type: "direct" as const, id: key },
    },
  };
}

function makeAgentMock(): AgentProtocolAdapter {
  return {
    runTurn: vi.fn().mockImplementation(async () => {
      // Default: resolve immediately so the lane goes idle quickly.
      return { text: "ok" };
    }),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    appendScheduledDelivery: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChannelMock(): ChannelAdapter {
  return {
    id: "tg",
    type: "telegram",
    capabilities: { chatTypes: ["direct"], edit: true },
    textChunkLimit: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMsg(text = "hello"): ChannelMessage {
  return {
    id: "m1",
    remoteChatId: "chat-1",
    chatType: "direct",
    senderId: "user1",
    text,
    timestamp: new Date(),
  };
}

describe("GatewaySessionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeManager(
    overrides: Partial<ConstructorParameters<typeof GatewaySessionManager>[0]> = {},
  ): { manager: GatewaySessionManager; agent: AgentProtocolAdapter } {
    const agent = makeAgentMock();
    const manager = new GatewaySessionManager({
      agent,
      idleTimeoutMs: 86_400_000,
      maxConcurrentSessions: 10,
      queueMode: "steer",
      ...overrides,
    });
    return { manager, agent };
  }

  it("lazily creates a lane on first enqueue", async () => {
    const { manager, agent } = makeManager();
    const channel = makeChannelMock();
    await manager.enqueue(route("tg:chat-1"), channel, makeMsg());
    expect(agent.runTurn).toHaveBeenCalledTimes(1);
  });

  it("evicts idle lanes past the idle timeout on cleanup tick", async () => {
    const { manager, agent } = makeManager({ idleTimeoutMs: 1000 });
    const channel = makeChannelMock();
    await manager.enqueue(route("tg:chat-1"), channel, makeMsg());
    expect(agent.runTurn).toHaveBeenCalledTimes(1);

    manager.startCleanupTimer();

    // Advance past the idle timeout + the 2-min cleanup interval.
    await vi.advanceTimersByTimeAsync(130_000);

    // closeSession should have been called for the evicted lane.
    expect(agent.closeSession).toHaveBeenCalledWith(route("tg:chat-1"));
  });

  it("does not evict a lane that is still running", async () => {
    const { manager, agent } = makeManager({ idleTimeoutMs: 1000 });

    // Create a lane and mark it as running (past idle timeout).
    const lane = manager.getOrCreate(route("tg:chat-1"));
    lane.status = "running";
    lane.lastActivity = 0; // long ago, past timeout

    manager.startCleanupTimer();
    await vi.advanceTimersByTimeAsync(130_000);

    // Running lane should not be closed.
    expect(agent.closeSession).not.toHaveBeenCalled();
  });

  it("evicts the oldest idle lane when maxConcurrent is exceeded", () => {
    const { manager, agent } = makeManager({ maxConcurrentSessions: 2 });

    // Create two lanes directly via getOrCreate (no runTurn involved).
    const lane1 = manager.getOrCreate(route("tg:chat-1"));
    const lane2 = manager.getOrCreate(route("tg:chat-2"));
    // Simulate lane2 still running (so it can't be evicted), lane1 idle.
    lane2.status = "running";
    lane1.lastActivity = 1000; // older than lane2
    lane2.lastActivity = 2000;

    // At capacity=2, getOrCreate a third → should evict lane1 (oldest idle).
    manager.getOrCreate(route("tg:chat-3"));

    expect(agent.closeSession).toHaveBeenCalledWith(route("tg:chat-1"));
    // chat-2 should not be evicted (it's running).
    expect(agent.closeSession).not.toHaveBeenCalledWith(route("tg:chat-2"));
  });

  it("stop() closes all open sessions and clears the timer", async () => {
    const { manager, agent } = makeManager();
    const channel = makeChannelMock();
    await manager.enqueue(route("tg:chat-1"), channel, makeMsg());
    await manager.enqueue(route("tg:chat-2"), channel, makeMsg());

    manager.startCleanupTimer();
    await manager.stop();

    expect(agent.closeSession).toHaveBeenCalledTimes(2);
    expect(agent.closeSession).toHaveBeenCalledWith(route("tg:chat-1"));
    expect(agent.closeSession).toHaveBeenCalledWith(route("tg:chat-2"));
  });

  it("startCleanupTimer is idempotent", () => {
    const { manager } = makeManager();
    manager.startCleanupTimer();
    manager.startCleanupTimer(); // should not throw or create a second timer
    // No assertion needed beyond not throwing; the timer is internal.
  });

  it("publishes a reset barrier, discards the old queue, and releases later messages", async () => {
    const { manager, agent } = makeManager();
    const current = route("tg:chat-1");
    const lane = manager.getOrCreate(current);
    lane.status = "running";
    lane.queue.push({ channel: makeChannelMock(), msg: makeMsg("old queued"), mode: "interrupt" });

    let releaseReset!: () => void;
    (agent.resetSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => (releaseReset = resolve)),
    );
    const reset = manager.reset(current);
    const later = manager.enqueue(current, makeChannelMock(), makeMsg("after reset"));

    expect(lane.queue).toHaveLength(0);
    expect(agent.runTurn).not.toHaveBeenCalled();
    releaseReset();
    await Promise.all([reset, later]);
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ route: current, text: "after reset" }),
    );
  });

  it("lets a later message continue after a failed reset", async () => {
    const { manager, agent } = makeManager();
    const current = route("tg:chat-1");
    (agent.resetSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const reset = manager.reset(current);
    const later = manager.enqueue(current, makeChannelMock(), makeMsg("after failure"));
    await expect(reset).rejects.toThrow("disk full");
    await later;
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ route: current, text: "after failure" }),
    );
  });
});
