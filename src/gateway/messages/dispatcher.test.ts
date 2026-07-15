import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import type { ChannelAdapter } from "../core/types.js";
import { GatewayMessageDispatcher } from "./dispatcher.js";
import { GatewayMessageStore } from "./store.js";
import { createInboxRecord, createOutboxRecord } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; store: GatewayMessageStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-dispatcher-"));
  roots.push(root);
  return { root, store: await GatewayMessageStore.open(root) };
}

function channel(): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct"] },
    textChunkLimit: 4096,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
  };
}

function record(updateId: string) {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: "chat" },
  };
  return createInboxRecord(
    {
      identity: { channel: "telegram", account: "primary", nativeUpdateId: updateId },
      route: { key: sessionKeyForLocator(locator), locator },
      message: {
        nativeMessageId: updateId,
        senderId: "user",
        text: `message-${updateId}`,
        timestamp: "2026-07-15T00:00:00.000Z",
      },
    },
    new Date("2026-07-15T00:00:00.000Z"),
  );
}

describe("GatewayMessageDispatcher", () => {
  it("recovers received work in order and records completion", async () => {
    const { store } = await setup();
    const first = record("1");
    const second = record("2");
    await store.createInbox(first);
    await store.createInbox(second);
    const handled: string[] = [];
    const dispatcher = new GatewayMessageDispatcher(
      [channel()],
      store,
      async (_channel, message) => {
        handled.push(message.text);
      },
    );

    await dispatcher.start();
    await vi.waitFor(() => expect(handled).toEqual(["message-1", "message-2"]));
    await dispatcher.stop();

    expect(store.getInbox(first.id)?.status).toBe("completed");
    expect(store.getInbox(second.id)?.status).toBe("completed");
  });

  it("marks crash-left processing work interrupted and never reruns it", async () => {
    const { root, store } = await setup();
    const input = record("crash");
    await store.createInbox(input);
    await store.updateInbox(input.id, (current) => ({
      ...current,
      status: "processing",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));

    const reopened = await GatewayMessageStore.open(root);
    const handler = vi.fn().mockResolvedValue(undefined);
    const interrupted = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new GatewayMessageDispatcher(
      [channel()],
      reopened,
      handler,
      undefined,
      interrupted,
    );
    await dispatcher.start();
    await dispatcher.stop();

    expect(handler).not.toHaveBeenCalled();
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(reopened.getInbox(input.id)).toMatchObject({
      status: "interrupted",
      error: { code: "PROCESS_INTERRUPTED" },
    });
  });

  it("completes crash-left processing when a final outbox already exists", async () => {
    const { store } = await setup();
    const input = record("with-final");
    await store.createInbox(input);
    await store.updateInbox(input.id, (current) => ({
      ...current,
      status: "processing",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    await store.createOutbox(
      createOutboxRecord({
        source: {
          kind: "inbox",
          id: input.id,
          attempt: 0,
          purpose: "final",
          ordinal: 0,
        },
        target: input.route.locator,
        text: "already durable",
      }),
    );
    const handler = vi.fn().mockResolvedValue(undefined);
    const interrupted = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new GatewayMessageDispatcher(
      [channel()],
      store,
      handler,
      undefined,
      interrupted,
    );

    await dispatcher.start();
    await dispatcher.stop();

    expect(store.getInbox(input.id)?.status).toBe("completed");
    expect(handler).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
  });
});
