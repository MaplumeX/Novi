import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionRoute } from "../core/types.js";
import { GatewayMessageStore } from "./store.js";
import {
  createInboxRecord,
  createOutboxRecord,
  inboxRecordId,
  type InboxRecord,
  type OutboxRecord,
} from "./types.js";

const roots: string[] = [];
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-messages-"));
  roots.push(root);
  return root;
}

function route(chatId = "chat-1"): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: chatId },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

function inbox(updateId: string, now = BASE_TIME): InboxRecord {
  return createInboxRecord(
    {
      identity: { channel: "telegram", account: "primary", nativeUpdateId: updateId },
      route: route(),
      message: {
        nativeMessageId: `message-${updateId}`,
        senderId: "user-1",
        text: `hello-${updateId}`,
        timestamp: now.toISOString(),
      },
    },
    now,
  );
}

function outbox(record: InboxRecord, ordinal = 0, now = BASE_TIME): OutboxRecord {
  return createOutboxRecord(
    {
      source: {
        kind: "inbox",
        id: record.id,
        attempt: record.attempt,
        purpose: "final",
        ordinal,
      },
      target: record.route.locator,
      text: `reply-${ordinal}`,
    },
    now,
  );
}

async function completeInbox(store: GatewayMessageStore, id: string): Promise<void> {
  await store.updateInbox(id, (record) => ({
    ...record,
    status: "processing",
    startedAt: BASE_TIME.toISOString(),
  }));
  await store.updateInbox(id, (record) => ({
    ...record,
    status: "completed",
    finishedAt: BASE_TIME.toISOString(),
  }));
}

async function deliverOutbox(store: GatewayMessageStore, id: string): Promise<void> {
  await store.updateOutbox(id, (record) => ({
    ...record,
    status: "sending",
    attempt: record.attempt + 1,
    startedAt: BASE_TIME.toISOString(),
  }));
  await store.updateOutbox(id, (record) => ({
    ...record,
    status: "delivered",
    finishedAt: BASE_TIME.toISOString(),
  }));
}

describe("GatewayMessageStore", () => {
  it("round-trips records and deduplicates exclusive deterministic creation", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root);
    const input = inbox("42");

    expect((await store.createInbox(input)).created).toBe(true);
    expect(
      (
        await store.createInbox({
          ...input,
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        })
      ).created,
    ).toBe(false);
    const delivery = outbox(input);
    expect((await store.createOutbox(delivery)).created).toBe(true);
    expect((await store.createOutbox(outbox(input))).created).toBe(false);

    const reopened = await GatewayMessageStore.open(root);
    expect(reopened.getInbox(input.id)?.message.text).toBe("hello-42");
    expect(reopened.getOutbox(delivery.id)?.text).toBe("reply-0");
    expect(reopened.snapshot()).toMatchObject({
      inbox: { received: 1 },
      outbox: { pending: 1 },
      nonTerminalRecords: 2,
      degraded: false,
    });
  });

  it("fails closed on corrupt or unsupported records and preserves the bytes", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root);
    const record = inbox("bad");
    await store.createInbox(record);
    const filePath = path.join(root, "inbox", record.id.slice(0, 2), `${record.id}.json`);
    const unsupported = `${JSON.stringify({ ...record, version: 2 }, null, 2)}\n`;
    await writeFile(filePath, unsupported, "utf8");

    await expect(GatewayMessageStore.open(root)).rejects.toThrow(
      /unsupported inbox record version/,
    );
    expect(await readFile(filePath, "utf8")).toBe(unsupported);

    await writeFile(filePath, "{broken", "utf8");
    await expect(GatewayMessageStore.open(root)).rejects.toThrow(/invalid Gateway message JSON/);
    expect(await readFile(filePath, "utf8")).toBe("{broken");
  });

  it("publishes neither memory nor disk when an atomic update fails", async () => {
    const root = await rootPath();
    let failWrites = false;
    const store = await GatewayMessageStore.open(root, {
      beforeRename: () => {
        if (failWrites) throw new Error("injected rename failure");
      },
    });
    const record = inbox("atomic");
    await store.createInbox(record);
    const filePath = path.join(root, "inbox", record.id.slice(0, 2), `${record.id}.json`);
    const before = await readFile(filePath, "utf8");
    failWrites = true;

    await expect(
      store.updateInbox(record.id, (current) => ({ ...current, status: "processing" })),
    ).rejects.toThrow(/injected rename failure/);
    expect(store.getInbox(record.id)?.status).toBe("received");
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("rejects illegal transitions and immutable intent changes", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root);
    const record = inbox("transition");
    await store.createInbox(record);

    await expect(
      store.updateInbox(record.id, (current) => ({ ...current, status: "completed" })),
    ).rejects.toThrow(/invalid inbox transition/);
    await expect(
      store.updateInbox(record.id, (current) => ({
        ...current,
        message: { ...current.message, text: "changed" },
      })),
    ).rejects.toThrow();
    expect(store.getInbox(record.id)?.status).toBe("received");
  });

  it("cleans only terminal records and respects the terminal count cap", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root, {
      retention: { retentionDays: 10_000, maxTerminalRecords: 1 },
      now: () => new Date("2026-03-01T00:00:00.000Z"),
    });
    const first = inbox("one", new Date("2026-01-01T00:00:00.000Z"));
    const second = inbox("two", new Date("2026-02-01T00:00:00.000Z"));
    const active = inbox("active", new Date("2025-01-01T00:00:00.000Z"));
    await store.createInbox(first);
    await store.createInbox(second);
    await store.createInbox(active);
    await completeInbox(store, first.id);
    await completeInbox(store, second.id);
    await store.updateInbox(active.id, (record) => ({
      ...record,
      status: "processing",
      startedAt: BASE_TIME.toISOString(),
    }));
    await store.updateInbox(active.id, (record) => ({ ...record, status: "interrupted" }));

    const snapshot = await store.cleanup();

    expect(store.getInbox(first.id)).toBeUndefined();
    expect(store.getInbox(second.id)?.status).toBe("completed");
    expect(store.getInbox(active.id)?.status).toBe("interrupted");
    expect(snapshot).toMatchObject({ terminalRecords: 1, nonTerminalRecords: 1, degraded: false });
  });

  it("reports degraded capacity instead of deleting nonterminal work", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root, { retention: { maxBytes: 1 } });
    const record = inbox("capacity");
    const delivery = outbox(record);
    await store.createInbox(record);
    await store.createOutbox(delivery);

    const snapshot = await store.cleanup();

    expect(snapshot.degraded).toBe(true);
    expect(snapshot.degradedReasons).toContain("message_store_byte_limit_exceeded");
    expect(store.getInbox(inboxRecordId(record.identity))).toBeDefined();
    expect(store.getOutbox(delivery.id)).toBeDefined();
  });

  it("enforces outbox attempt claims and persists delivery terminal state", async () => {
    const root = await rootPath();
    const store = await GatewayMessageStore.open(root);
    const record = inbox("delivery");
    const delivery = outbox(record);
    await store.createOutbox(delivery);

    await expect(
      store.updateOutbox(delivery.id, (current) => ({ ...current, status: "sending" })),
    ).rejects.toThrow(/increment attempt/);
    await deliverOutbox(store, delivery.id);
    expect(store.getOutbox(delivery.id)).toMatchObject({ status: "delivered", attempt: 1 });
  });
});
