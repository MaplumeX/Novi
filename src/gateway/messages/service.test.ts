import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionRoute } from "../core/types.js";
import { GatewayMessageService } from "./service.js";
import { GatewayMessageStore } from "./store.js";
import { createInboxRecord, createOutboxRecord } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function route(chatId: string): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: chatId },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-message-service-"));
  roots.push(root);
  return GatewayMessageStore.open(root);
}

function inbox(owner: GatewaySessionRoute, updateId: string) {
  return createInboxRecord({
    identity: { channel: "telegram", account: "primary", nativeUpdateId: updateId },
    route: owner,
    message: {
      nativeMessageId: updateId,
      senderId: "user",
      text: "secret body",
      timestamp: "2026-07-15T00:00:00.000Z",
    },
  });
}

describe("GatewayMessageService", () => {
  it("creates an explicit child retry and enforces route isolation", async () => {
    const store = await setup();
    const owner = route("one");
    const original = inbox(owner, "42");
    await store.createInbox(original);
    await store.updateInbox(original.id, (record) => ({
      ...record,
      status: "processing",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    await store.updateInbox(original.id, (record) => ({ ...record, status: "interrupted" }));
    const wake = vi.fn();
    const service = new GatewayMessageService(store, wake);

    await expect(service.retry(route("two"), original.id)).rejects.toThrow(/not found/);
    const retried = await service.retry(owner, original.id);

    expect(retried).toMatchObject({ status: "received", attempt: 1, parentMessageId: original.id });
    expect(store.getInbox(original.id)?.status).toBe("interrupted");
    expect(wake).toHaveBeenCalledWith(owner.key);
    expect(service.list(route("two"))).toEqual([]);
  });

  it("rejects active dismiss and permits interrupted dismiss", async () => {
    const store = await setup();
    const owner = route("one");
    const original = inbox(owner, "dismiss");
    await store.createInbox(original);
    const service = new GatewayMessageService(store);
    await expect(service.dismiss(original.id)).rejects.toThrow(/active/);
    await store.updateInbox(original.id, (record) => ({
      ...record,
      status: "processing",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    await store.updateInbox(original.id, (record) => ({ ...record, status: "interrupted" }));
    expect(await service.dismiss(original.id)).toMatchObject({ status: "dismissed" });
  });

  it("creates a new delivery fact when explicitly retrying a failed outbox", async () => {
    const store = await setup();
    const owner = route("one");
    const original = inbox(owner, "delivery");
    await store.createInbox(original);
    const delivery = createOutboxRecord({
      source: { kind: "inbox", id: original.id, attempt: 0, purpose: "final", ordinal: 0 },
      target: owner.locator,
      text: "stable reply",
    });
    await store.createOutbox(delivery);
    await store.updateOutbox(delivery.id, (record) => ({
      ...record,
      status: "sending",
      attempt: 1,
    }));
    await store.updateOutbox(delivery.id, (record) => ({
      ...record,
      status: "delivery_failed",
    }));
    const wake = vi.fn();
    const service = new GatewayMessageService(store, undefined, wake);

    await expect(service.retryDelivery(route("two"), delivery.id)).rejects.toThrow(/not found/);
    const retried = await service.retryDelivery(owner, delivery.id);

    expect(retried).toMatchObject({ status: "pending", text: "stable reply" });
    expect(retried.id).not.toBe(delivery.id);
    expect(store.getOutbox(delivery.id)?.status).toBe("delivery_failed");
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
