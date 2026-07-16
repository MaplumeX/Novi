import { describe, expect, it, vi } from "vitest";
import type { AgentProtocolAdapter } from "./types.js";
import type { ChannelAdapter, ChannelMessage } from "./types.js";
import type { QueueMode } from "../config.js";
import {
  createSessionLane as createRouteLane,
  enqueueMessage,
  type QueuedMessage,
} from "./session-lane.js";

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

function createSessionLane(key: string) {
  return createRouteLane(route(key));
}

/** Build a mock AgentProtocolAdapter with vi.fn for every method. */
function makeAgentMock(): AgentProtocolAdapter {
  // Simulate the real adapter: runTurn invokes onTurnEnd with the final text.
  const runTurn = vi.fn().mockImplementation(
    async (input: {
      route: ReturnType<typeof route>;
      text: string;
      images?: { type: string; data: string; mimeType: string }[];
      callbacks?: {
        onTurnEnd?(text: string): Promise<void>;
      };
    }) => {
      await input.callbacks?.onTurnEnd?.("reply");
      return { text: "reply" };
    },
  );
  return {
    runTurn,
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    appendScheduledDelivery: vi.fn().mockResolvedValue(undefined),
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
      expect.objectContaining({ route: expect.objectContaining({ key: "tg:123" }), text: "hi" }),
    );
    // onTurnEnd callback → channel.send with final text.
    expect(channel.send).toHaveBeenCalledWith({ chatId: "123" }, "reply");
    // Status should be idle after the turn completes.
    expect(lane.status).toBe("idle");
  });

  it("sends an error message if runTurn throws", async () => {
    const agent = makeAgentMock();
    (agent.runTurn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("hi"), "steer"));

    expect(channel.send).toHaveBeenCalledWith({ chatId: "123" }, expect.stringContaining("boom"));
    expect(lane.status).toBe("idle");
  });

  it("removes a streamed placeholder instead of sending a SILENT final reply", async () => {
    const agent = makeAgentMock();
    (agent.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { callbacks?: { onTurnEnd?(text: string): Promise<void> } }) => {
        await input.callbacks?.onTurnEnd?.("SILENT");
        return { text: "SILENT" };
      },
    );
    const channel = makeChannelMock();
    channel.cancelStream = vi.fn().mockResolvedValue(undefined);
    await enqueueMessage(
      createSessionLane("tg:123"),
      agent,
      makeEntry(channel, makeMsg("hi"), "steer"),
    );
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.cancelStream).toHaveBeenCalledWith({ chatId: "123" });
  });

  it("buffers silent marker prefixes and releases ordinary text once in order", async () => {
    const agent = makeAgentMock();
    (agent.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: {
        callbacks?: {
          onTextDelta?(text: string): Promise<void>;
          onTurnEnd?(text: string): Promise<void>;
        };
      }) => {
        for (const delta of ["S", "I", "L", "E", "N", "T"])
          await input.callbacks?.onTextDelta?.(delta);
        await input.callbacks?.onTurnEnd?.("SILENT");
        return { text: "SILENT" };
      },
    );
    const silentChannel = makeChannelMock();
    await enqueueMessage(
      createSessionLane("tg:silent"),
      agent,
      makeEntry(silentChannel, makeMsg("hi"), "steer"),
    );
    expect(silentChannel.sendEvent).not.toHaveBeenCalled();

    (agent.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: {
        callbacks?: {
          onTextDelta?(text: string): Promise<void>;
          onTurnEnd?(text: string): Promise<void>;
        };
      }) => {
        for (const delta of ["S", "o", "!", " more"]) await input.callbacks?.onTextDelta?.(delta);
        await input.callbacks?.onTurnEnd?.("So! more");
        return { text: "So! more" };
      },
    );
    const ordinaryChannel = makeChannelMock();
    await enqueueMessage(
      createSessionLane("tg:ordinary"),
      agent,
      makeEntry(ordinaryChannel, makeMsg("hi"), "steer"),
    );
    expect(ordinaryChannel.sendEvent).toHaveBeenCalledTimes(3);
    expect(ordinaryChannel.sendEvent).toHaveBeenNthCalledWith(
      1,
      { chatId: "123" },
      {
        type: "text-delta",
        delta: "So",
      },
    );
    expect(ordinaryChannel.sendEvent).toHaveBeenNthCalledWith(
      2,
      { chatId: "123" },
      {
        type: "text-delta",
        delta: "!",
      },
    );
    expect(ordinaryChannel.sendEvent).toHaveBeenNthCalledWith(
      3,
      { chatId: "123" },
      {
        type: "text-delta",
        delta: " more",
      },
    );
  });
});

describe("enqueueMessage (running + steer mode)", () => {
  it("calls agent.steer when running and mode=steer", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("more"), "steer"));

    expect(agent.steer).toHaveBeenCalledWith(route("tg:123"), "more");
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
    expect(agent.followUp).toHaveBeenCalledWith(route("tg:123"), "msg");
    // Both failed → queued as interrupt for after the run.
    expect(lane.queue).toHaveLength(1);
    expect((lane.queue[0] as QueuedMessage).mode).toBe("interrupt");
  });

  it("falls back to followUp when steer throws (followUp succeeds)", async () => {
    const agent = makeAgentMock();
    (agent.steer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no"));
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("msg"), "steer"));

    expect(agent.followUp).toHaveBeenCalledWith(route("tg:123"), "msg");
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

    expect(agent.followUp).toHaveBeenCalledWith(route("tg:123"), "msg");
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
    expect((lane.queue[0] as QueuedMessage).mode).toBe("interrupt");
  });
});

describe("enqueueMessage (running + interrupt mode)", () => {
  it("aborts the current run and queues for a fresh turn", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    lane.status = "running";

    await enqueueMessage(lane, agent, makeEntry(channel, makeMsg("new"), "interrupt"));

    expect(agent.abort).toHaveBeenCalledWith(route("tg:123"));
    expect(lane.queue).toHaveLength(1);
    expect((lane.queue[0] as QueuedMessage).msg.text).toBe("new");
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

describe("enqueueMessage (images passthrough)", () => {
  it("passes msg.images through to agent.runTurn", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const images = [{ type: "image" as const, data: "base64", mimeType: "image/png" }];
    const msg = { ...makeMsg("hi"), images };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hi", images }),
    );
  });
});

describe("enqueueMessage (attachment description injection)", () => {
  it("injects file attachment description into turn text", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg("see this report"),
      attachments: [
        {
          kind: "file",
          mimeType: "application/pdf",
          size: 12345,
          filename: "report.pdf",
          localPath: "gateway-media/ab/id-report.pdf",
        },
      ],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('[attachment: file "report.pdf"'),
      }),
    );
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toContain("see this report");
    expect(call.text).toContain("application/pdf");
    expect(call.text).toContain("12345 bytes");
    expect(call.text).toContain("gateway-media/ab/id-report.pdf");
  });

  it("injects voice attachment description into turn text", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg("listen to this"),
      attachments: [
        {
          kind: "voice",
          mimeType: "audio/ogg",
          size: 5000,
          localPath: "gateway-media/cd/id-voice.ogg",
        },
      ],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toContain("listen to this");
    expect(call.text).toContain("[attachment: voice");
    expect(call.text).toContain("audio/ogg");
  });

  it("does not inject text for image attachments (they go through images)", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg("look at this"),
      attachments: [
        {
          kind: "image",
          mimeType: "image/jpeg",
          size: 5000,
          localPath: "gateway-media/ab/id-photo.jpg",
        },
      ],
      images: [{ type: "image", data: "base64", mimeType: "image/jpeg" }],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Text should be just the caption, no attachment description for images.
    expect(call.text).toBe("look at this");
    expect(call.text).not.toContain("[attachment:");
  });

  it("does not inject text for attachments without localPath", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg("check this"),
      attachments: [
        {
          kind: "file",
          mimeType: "application/pdf",
          size: 12345,
          filename: "report.pdf",
          remoteFileId: "abc",
        },
      ],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toBe("check this");
  });

  it("appends attachment description with newline when caption is non-empty", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg("my caption"),
      attachments: [
        {
          kind: "file",
          mimeType: "text/plain",
          size: 100,
          filename: "notes.txt",
          localPath: "gateway-media/ef/id-notes.txt",
        },
      ],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toBe("my caption\n[attachment: file \"notes.txt\" (text/plain, 100 bytes) at gateway-media/ef/id-notes.txt]");
  });

  it("injects attachment description without leading newline when caption is empty", async () => {
    const agent = makeAgentMock();
    const channel = makeChannelMock();
    const lane = createSessionLane("tg:123");
    const msg: ChannelMessage = {
      ...makeMsg(""),
      attachments: [
        {
          kind: "file",
          mimeType: "text/plain",
          size: 100,
          filename: "notes.txt",
          localPath: "gateway-media/ef/id-notes.txt",
        },
      ],
    };
    await enqueueMessage(lane, agent, makeEntry(channel, msg, "steer"));
    const call = (agent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toBe("[attachment: file \"notes.txt\" (text/plain, 100 bytes) at gateway-media/ef/id-notes.txt]");
  });
});
