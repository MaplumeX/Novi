import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import type { ChannelAdapter, GatewaySessionRoute } from "../core/types.js";
import { FinalDeliverySink } from "./sink.js";
import { ChannelDeliveryExecutor } from "./delivery.js";
import { OutboxDeliveryWorker } from "./outbox.js";
import { GatewayMessageStore } from "./store.js";
import { createInboxRecord } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function channelMock(): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct"], edit: true },
    textChunkLimit: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ messageIds: ["out-1"] }),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelStream: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-sink-"));
  roots.push(root);
  const store = await GatewayMessageStore.open(root);
  const mockChannel = channelMock();
  const worker = new OutboxDeliveryWorker(
    [mockChannel],
    store,
    new ChannelDeliveryExecutor(),
  );
  return { store, worker };
}

function route(chatId = "chat-1"): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: chatId },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

describe("FinalDeliverySink", () => {
  it("passes replyToMessageId from target through to outbox locator.replyTo", async () => {
    const { store, worker } = await setup();
    const r = route();
    const inbox = createInboxRecord({
      identity: { channel: "telegram", account: "primary", nativeUpdateId: "42" },
      route: r,
      message: {
        nativeMessageId: "m42",
        senderId: "user",
        text: "hello",
        timestamp: "2026-07-15T00:00:00.000Z",
      },
    });
    await store.createInbox(inbox);
    const channel = channelMock();
    const sink = new FinalDeliverySink(store, worker);
    const durable = sink.forInbox(channel, inbox, "final");
    // Simulate the session-lane calling send with a replyToMessageId target.
    await durable.send(
      { chatId: "chat-1", replyToMessageId: "msg-99" },
      "reply text",
    );
    const outboxRecords = store.listOutbox();
    expect(outboxRecords).toHaveLength(1);
    expect(outboxRecords[0]!.target.replyTo).toBe("msg-99");
  });

  it("omits replyTo in locator when target has no replyToMessageId", async () => {
    const { store, worker } = await setup();
    const r = route();
    const inbox = createInboxRecord({
      identity: { channel: "telegram", account: "primary", nativeUpdateId: "42" },
      route: r,
      message: {
        nativeMessageId: "m42",
        senderId: "user",
        text: "hello",
        timestamp: "2026-07-15T00:00:00.000Z",
      },
    });
    await store.createInbox(inbox);
    const channel = channelMock();
    const sink = new FinalDeliverySink(store, worker);
    const durable = sink.forInbox(channel, inbox, "final");
    await durable.send({ chatId: "chat-1" }, "reply text");
    const outboxRecords = store.listOutbox();
    expect(outboxRecords).toHaveLength(1);
    expect(outboxRecords[0]!.target.replyTo).toBeUndefined();
  });
});