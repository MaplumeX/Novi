import { describe, expect, it, vi } from "vitest";
import type { AgentProtocolAdapter } from "./types.js";
import type { ChannelAdapter, ChannelMessage } from "./types.js";
import type { QueueMode } from "../config.js";
import { createSessionLane, enqueueMessage } from "./session-lane.js";

/** Build a mock AgentProtocolAdapter with vi.fn for every method. */
function makeAgentMock(): AgentProtocolAdapter {
  // Simulate the real adapter: runTurn invokes onTurnEnd with the final text.
  const runTurn = vi.fn().mockImplementation(async (input: {
    sessionKey: string;
    text: string;
    callbacks?: {
      onTurnEnd?(text: string): Promise<void>;
    };
  }) => {
    await input.callbacks?.onTurnEnd?.("reply");
    return { text: "reply" };
  });
  return {
    runTurn,
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a mock ChannelAdapter that records sends. */
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

function makeMsg(text: string): ChannelMessage {
  return {
    id: "m1",
    remoteChatId: "123",
    chatType: "direct",
    senderId: "user1",
    text,
    timestamp: new Date(),
  };
}

function makeEntry(channel: ChannelAdapter, msg: ChannelMessage, mode: QueueMode) {
  return { channel, msg, mode };
}

describe("enqueueMessage (idle state)", () => {
  it("starts a turn immediately when idle, then returns to idle", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    expect(lane.status).toBe("idle");

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("hi"), "steer"));

    expect(agent.runTurn).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "tg:123", text: "hi" }),
    );
    // onTurnEnd callback → channel.send with final text.
    expect(channel.send).toHaveBeenCalledWith("123", "reply");
    // Status should be idle after the turn completes.
    expect(lane.status).toBe("idle");
  });

  it("sends an error message if runTurn throws", async () => {
    const agent = makeAgentMock();
    (agent.runTurn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("hi"), "steer"));

    expect(channel.send).toHaveBeenCalledWith("123", expect.stringContaining("boom"));
    expect(lane.status).toBe("idle");
  });
});

describe("enqueueMessage (running + steer mode)", () => {
  it("calls agent.steer when running and mode=steer", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("more"), "steer"));

    expect(agent.steer).toHaveBeenCalledWith("tg:123", "more");
    expect(agent.runTurn).not.toHaveBeenCalled();
    // Steer messages are not enqueued locally.
    expect(lane.queue).toHaveLength(0);
  });

  it("falls back to followUp when steer throws, then queues if followUp also throws", async () => {
    const agent = makeAgentMock();
    (agent.steer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not steerable"));
    (agent.followUp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not now"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("msg"), "steer"));

    expect(agent.steer).toHaveBeenCalled();
    expect(agent.followUp).toHaveBeenCalledWith("tg:123", "msg");
    // Both failed → queued as interrupt for after the run.
    expect(lane.queue).toHaveLength(1);
    expect(lane.queue[0].mode).toBe("interrupt");
  });

  it("falls back to followUp when steer throws (followUp succeeds)", async () => {
    const agent = makeAgentMock();
    (agent.steer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("msg"), "steer"));

    expect(agent.followUp).toHaveBeenCalledWith("tg:123", "msg");
    expect(lane.queue).toHaveLength(0);
  });
});

describe("enqueueMessage (running + followup mode)", () => {
  it("calls agent.followUp when running and mode=followup", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("msg"), "followup"));

    expect(agent.followUp).toHaveBeenCalledWith("tg:123", "msg");
    expect(lane.queue).toHaveLength(0);
  });

  it("queues as interrupt when followUp throws", async () => {
    const agent = makeAgentMock();
    (agent.followUp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("busy"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("msg"), "followup"));

    expect(lane.queue).toHaveLength(1);
    expect(lane.queue[0].mode).toBe("interrupt");
  });
});

describe("enqueueMessage (running + interrupt mode)", () => {
  it("aborts the current run and queues for a fresh turn", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("new"), "interrupt"));

    expect(agent.abort).toHaveBeenCalledWith("tg:123");
    expect(lane.queue).toHaveLength(1);
    expect(lane.queue[0].msg.text).toBe("new");
  });

  it("still queues when abort throws", async () => {
    const agent = makeAgentMock();
    (agent.abort as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("new"), "interrupt"));

    expect(lane.queue).toHaveLength(1);
  });
});

describe("enqueueMessage (queue draining)", () => {
  it("processes queued interrupt messages after the current turn ends", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    // Queue two interrupt messages while "running".
    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("m1"), "interrupt"));
    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("m2"), "interrupt"));
    expect(lane.queue).toHaveLength(2);

    // Now simulate the run ending: enqueue an idle message, which will run
    // and then drain the queue.
    lane.status = "idle";
    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("idle-msg"), "steer"));

    // runTurn called once for idle-msg + once per queued message = 3 total.
    expect(agent.runTurn).toHaveBeenCalledTimes(3);
    expect(lane.queue).toHaveLength(0);
    expect(lane.status).toBe("idle");
  });
});