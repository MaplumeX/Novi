import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../core/types.js";
import { ChannelDeliveryExecutor } from "./delivery.js";
import { OutboxDeliveryWorker } from "./outbox.js";
import { DeliveryRateLimiter } from "./rate-limit.js";
import { GatewayMessageStore } from "./store.js";
import { createOutboxRecord } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-outbox-"));
  roots.push(root);
  return GatewayMessageStore.open(root);
}

function record() {
  return createOutboxRecord(
    {
      source: { kind: "system", id: "test", attempt: 0, purpose: "alert", ordinal: 0 },
      target: {
        channel: "telegram",
        account: "primary",
        chat: { type: "direct", id: "chat" },
      },
      text: "durable reply",
    },
    new Date("2026-07-15T00:00:00.000Z"),
  );
}

function executor() {
  return new ChannelDeliveryExecutor(
    new DeliveryRateLimiter({}, { now: () => 0, sleep: async () => Promise.resolve() }),
  );
}

function channel(sendFinalChunk: ChannelAdapter["sendFinalChunk"]): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct"] },
    textChunkLimit: 4096,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    sendFinalChunk,
  };
}

describe("OutboxDeliveryWorker", () => {
  it("persists sending before the API call and records the chunk receipt", async () => {
    const store = await setup();
    const pending = record();
    await store.createOutbox(pending);
    const send = vi.fn(async () => {
      expect(store.getOutbox(pending.id)?.status).toBe("sending");
      return { messageId: "telegram-1" };
    });
    const worker = new OutboxDeliveryWorker([channel(send)], store, executor());

    await worker.start();
    await vi.waitFor(() => expect(store.getOutbox(pending.id)?.status).toBe("delivered"));
    await worker.stop();

    expect(store.getOutbox(pending.id)).toMatchObject({
      attempt: 1,
      receipts: [{ ordinal: 0, messageId: "telegram-1" }],
    });
  });

  it("marks a crash-left sending attempt ambiguous before resuming", async () => {
    const store = await setup();
    const pending = record();
    await store.createOutbox(pending);
    await store.updateOutbox(pending.id, (current) => ({
      ...current,
      status: "sending",
      attempt: 1,
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    const worker = new OutboxDeliveryWorker(
      [channel(vi.fn().mockResolvedValue({ messageId: "telegram-2" }))],
      store,
      executor(),
    );

    await worker.start();
    await vi.waitFor(() => expect(store.getOutbox(pending.id)?.status).toBe("delivered"));
    await worker.stop();

    expect(store.getOutbox(pending.id)).toMatchObject({
      attempt: 2,
      deliveryAmbiguous: true,
      possibleDuplicate: true,
    });
  });

  it("retries retryable failures without changing the persisted text", async () => {
    const store = await setup();
    const pending = record();
    await store.createOutbox(pending);
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 429, parameters: { retry_after: 0 } })
      .mockResolvedValueOnce({ messageId: "telegram-3" });
    const worker = new OutboxDeliveryWorker([channel(send)], store, executor());

    await worker.start();
    await vi.waitFor(() => expect(store.getOutbox(pending.id)?.status).toBe("delivered"));
    await worker.stop();

    expect(store.getOutbox(pending.id)).toMatchObject({ attempt: 2, text: "durable reply" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
