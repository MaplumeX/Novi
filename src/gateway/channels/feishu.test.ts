import { describe, it, expect, vi } from "vitest";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { ChannelMessage } from "../core/types.js";
import {
  FeishuChannel,
  type FeishuChannelOptions,
  type LarkChannelLike,
  type LarkChannelFactory,
} from "./feishu.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal NormalizedMessage for testing. */
function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-001",
    chatId: "chat-abc",
    chatType: "p2p",
    senderId: "user-123",
    content: "hello world",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1700000000000,
    ...overrides,
  };
}

/** Create a mock LarkChannelLike for testing. */
function createMockChannel(
  overrides: Partial<LarkChannelLike> = {},
): LarkChannelLike & {
  messageHandler: ((msg: NormalizedMessage) => void | Promise<void>) | undefined;
  errorHandler: ((err: unknown) => void) | undefined;
  sentCalls: Array<{ to: string; input: unknown; opts: unknown }>;
  connectMock: ReturnType<typeof vi.fn>;
  disconnectMock: ReturnType<typeof vi.fn>;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const state: {
    messageHandler: ((msg: NormalizedMessage) => void | Promise<void>) | undefined;
    errorHandler: ((err: unknown) => void) | undefined;
  } = { messageHandler: undefined, errorHandler: undefined };
  const sentCalls: Array<{ to: string; input: unknown; opts: unknown }> = [];

  const connectMock = vi.fn(async () => {});
  const disconnectMock = vi.fn(async () => {});
  const sendMock = vi.fn(async (to: string, input: unknown, opts?: unknown) => {
    sentCalls.push({ to, input, opts });
    return { messageId: `sent-${sentCalls.length}` };
  });

  const base: LarkChannelLike = {
    on(name: string, handler: unknown) {
      if (name === "message") state.messageHandler = handler as typeof state.messageHandler;
      if (name === "error") state.errorHandler = handler as typeof state.errorHandler;
      return () => {};
    },
    connect: connectMock,
    disconnect: disconnectMock,
    send: sendMock,
    botIdentity: { openId: "bot-open-id", name: "Novi Bot" },
  };

  // Apply overrides first, then define live getter properties.
  Object.assign(base, overrides);
  const wrapper = base as LarkChannelLike & {
    messageHandler: ((msg: NormalizedMessage) => void | Promise<void>) | undefined;
    errorHandler: ((err: unknown) => void) | undefined;
    sentCalls: Array<{ to: string; input: unknown; opts: unknown }>;
    connectMock: ReturnType<typeof vi.fn>;
    disconnectMock: ReturnType<typeof vi.fn>;
    sendMock: ReturnType<typeof vi.fn>;
  };
  Object.defineProperties(wrapper, {
    messageHandler: {
      get: () => state.messageHandler,
      enumerable: true,
      configurable: true,
    },
    errorHandler: {
      get: () => state.errorHandler,
      enumerable: true,
      configurable: true,
    },
  });
  wrapper.sentCalls = sentCalls;
  wrapper.connectMock = connectMock;
  wrapper.disconnectMock = disconnectMock;
  wrapper.sendMock = sendMock;
  return wrapper;
}

/** Create a FeishuChannel with a mock factory. */
function createChannel(mockChannel?: ReturnType<typeof createMockChannel>) {
  const mock = mockChannel ?? createMockChannel();
  const factory: LarkChannelFactory = () => mock;
  const options: FeishuChannelOptions = {
    id: "primary",
    appId: "cli_test",
    appSecret: "secret_test",
    larkChannelFactory: factory,
  };
  const channel = new FeishuChannel(options);
  return { channel, mock };
}

// ---------------------------------------------------------------------------
// Capability declaration
// ---------------------------------------------------------------------------

describe("FeishuChannel capabilities", () => {
  it("declares edit=false, threads=false, media=false (differs from Telegram)", () => {
    const { channel } = createChannel();
    expect(channel.capabilities.edit).toBe(false);
    expect(channel.capabilities.threads).toBe(false);
    expect(channel.capabilities.media).toBe(false);
    expect(channel.capabilities.markdown).toBe(true);
    expect(channel.capabilities.blockStreaming).toBe(false);
    expect(channel.capabilities.chatTypes).toEqual(["direct", "group"]);
  });

  it("has textChunkLimit = 4000", () => {
    const { channel } = createChannel();
    expect(channel.textChunkLimit).toBe(4000);
  });

  it("does not implement sendEvent (edit=false)", () => {
    const { channel } = createChannel();
    // sendEvent is optional on ChannelAdapter; FeishuChannel does not implement it.
    expect(Object.prototype.hasOwnProperty.call(channel, "sendEvent")).toBe(false);
  });

  it("implements sendFinalChunk for durable chunk delivery", () => {
    const { channel } = createChannel();
    expect(channel.sendFinalChunk).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("FeishuChannel lifecycle", () => {
  it("start connects and registers handlers", async () => {
    const { channel, mock } = createChannel();
    await channel.start();
    expect(mock.connectMock.mock.calls.length).toBe(1);
    expect(mock.messageHandler).toBeDefined();
    expect(mock.errorHandler).toBeDefined();
  });

  it("start throws if already running", async () => {
    const { channel } = createChannel();
    await channel.start();
    await expect(channel.start()).rejects.toThrow("already running");
  });

  it("stop disconnects the channel", async () => {
    const { channel, mock } = createChannel();
    await channel.start();
    await channel.stop();
    expect(mock.disconnectMock.mock.calls.length).toBe(1);
  });

  it("stop is a no-op when not started", async () => {
    const { channel, mock } = createChannel();
    await channel.stop();
    expect(mock.disconnectMock.mock.calls.length).toBe(0);
  });

  it("probe returns ok with bot name when connected", async () => {
    const { channel } = createChannel();
    await channel.start();
    const result = await channel.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("Novi Bot");
  });

  it("probe returns not ok when not connected", async () => {
    const { channel } = createChannel();
    const result = await channel.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not connected");
  });

  it("getFailure returns undefined initially", () => {
    const { channel } = createChannel();
    expect(channel.getFailure()).toBeUndefined();
  });

  it("getFailure exposes error from SDK error event", async () => {
    const { channel, mock } = createChannel();
    await channel.start();
    mock.errorHandler?.(new Error("WS connection lost"));
    expect(channel.getFailure()?.message).toBe("WS connection lost");
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("FeishuChannel.normalizeMessage (via inbound emission)", () => {
  it("normalizes a p2p text message to direct chat", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ chatType: "p2p", content: "hello" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const msg = emitted[0];
    expect(msg.chatType).toBe("direct");
    expect(msg.remoteChatId).toBe("chat-abc");
    expect(msg.senderId).toBe("user-123");
    expect(msg.text).toBe("hello");
    expect(msg.id).toBe("msg-001");
    expect(msg.timestamp).toEqual(new Date(1700000000000));
    expect(msg.metadata?.feishuChatType).toBe("p2p");
    expect(msg.metadata?.feishuRawContentType).toBe("text");
    expect(msg.metadata?.unsupported).toBeUndefined();
  });

  it("normalizes a group message", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ chatType: "group", content: "group hello" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].chatType).toBe("group");
    expect(emitted[0].metadata?.feishuChatType).toBe("group");
  });

  it("includes senderName when present", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ senderName: "Alice" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].senderName).toBe("Alice");
  });

  it("omits senderName when absent", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ senderName: undefined }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].senderName).toBeUndefined();
  });

  it("includes replyToMessageId when present", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ replyToMessageId: "msg-000" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].replyToMessageId).toBe("msg-000");
  });

  it("includes threadId when present", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ threadId: "thread-1" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].threadId).toBe("thread-1");
  });

  it("includes mentionedBot in metadata", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ mentionedBot: true }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].metadata?.mentionedBot).toBe(true);
  });

  it("diagnoses non-text messages with unsupported metadata", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ rawContentType: "image", content: "" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const msg = emitted[0];
    expect(msg.metadata?.unsupported).toBe("image");
    expect(msg.text).toContain("unsupported message type: image");
    expect(msg.text).not.toBe(""); // diagnostic text, not empty
  });

  it("uses messageId as updateId for dedup", async () => {
    const { channel, mock } = createChannel();
    const emitted: ChannelMessage[] = [];
    channel.onMessage = async (msg) => { emitted.push(msg); };
    await channel.start();

    mock.messageHandler?.(makeMsg({ messageId: "dedup-123" }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].metadata?.updateId).toBe("dedup-123");
  });
});

// ---------------------------------------------------------------------------
// Outbound send
// ---------------------------------------------------------------------------

describe("FeishuChannel.send", () => {
  it("sends a single chunk for short text", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    const receipt = await channel.send({ chatId: "chat-abc" }, "hello");
    expect(receipt.messageIds).toHaveLength(1);
    expect(mock.sentCalls).toHaveLength(1);
    expect(mock.sentCalls[0].to).toBe("chat-abc");
    expect(mock.sentCalls[0].input).toEqual({ markdown: "hello" });
    expect(mock.sentCalls[0].opts).toEqual({});
  });

  it("chunks text exceeding the limit", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    const longText = "a".repeat(4001);
    const receipt = await channel.send({ chatId: "chat-abc" }, longText);
    expect(receipt.messageIds).toHaveLength(2);
    expect(mock.sentCalls).toHaveLength(2);
    expect(mock.sentCalls[0].input).toEqual({ markdown: "a".repeat(4000) });
    expect(mock.sentCalls[1].input).toEqual({ markdown: "a" });
  });

  it("uses replyTo option when replyToMessageId is present", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    await channel.send({ chatId: "chat-abc", replyToMessageId: "msg-999" }, "reply text");
    expect(mock.sentCalls[0].opts).toEqual({ replyTo: "msg-999" });
  });

  it("does not use replyTo when replyToMessageId is absent", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    await channel.send({ chatId: "chat-abc" }, "plain text");
    expect(mock.sentCalls[0].opts).toEqual({});
  });

  it("ignores threadId (threads=false)", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    await channel.send({ chatId: "chat-abc", threadId: "thread-1" }, "text");
    // No thread-related options should be passed — just the basic send.
    expect(mock.sentCalls[0].opts).toEqual({});
  });

  it("throws if channel not started", async () => {
    const { channel } = createChannel();
    await expect(channel.send({ chatId: "chat-abc" }, "text")).rejects.toThrow("not started");
  });
});

describe("FeishuChannel.sendFinalChunk", () => {
  it("sends a single chunk and returns messageId", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    const receipt = await channel.sendFinalChunk({ chatId: "chat-abc" }, "final text", 0);
    expect(receipt.messageId).toBe("sent-1");
    expect(mock.sentCalls).toHaveLength(1);
  });

  it("uses replyTo when present", async () => {
    const { channel, mock } = createChannel();
    await channel.start();

    await channel.sendFinalChunk(
      { chatId: "chat-abc", replyToMessageId: "msg-999" },
      "final reply",
      0,
    );
    expect(mock.sentCalls[0].opts).toEqual({ replyTo: "msg-999" });
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget inbound
// ---------------------------------------------------------------------------

describe("FeishuChannel fire-and-forget", () => {
  it("emits message without blocking on slow onMessage", async () => {
    const { channel, mock } = createChannel();
    let onMessageCalled = false;
    channel.onMessage = async () => {
      onMessageCalled = true;
      // Simulate slow downstream processing.
      await new Promise((r) => setTimeout(r, 500));
    };
    await channel.start();

    const start = Date.now();
    // handleMessage is fire-and-forget — should return immediately.
    mock.messageHandler?.(makeMsg());
    const elapsed = Date.now() - start;
    // The handler itself should not block for the 500ms downstream delay.
    expect(elapsed).toBeLessThan(100);
    // But the onMessage callback does get called eventually.
    await vi.waitFor(() => expect(onMessageCalled).toBe(true));
  });
});