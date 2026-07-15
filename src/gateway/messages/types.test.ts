import { describe, expect, it } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionRoute } from "../core/types.js";
import {
  MAX_GATEWAY_MESSAGE_BYTES,
  MAX_MESSAGE_ERROR_BYTES,
  assertInboxTransition,
  assertOutboxTransition,
  createInboxRecord,
  createOutboxRecord,
  decodeInboxRecord,
  decodeOutboxRecord,
  inboxRecordId,
  messageContentHash,
  outboxRecordId,
  type InboxIdentity,
  type OutboxSource,
} from "./types.js";

const NOW = new Date("2026-07-15T00:00:00.000Z");

function route(chatId = "chat-1"): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: chatId },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

function identity(updateId = "42"): InboxIdentity {
  return { channel: "telegram", account: "primary", nativeUpdateId: updateId };
}

function source(): OutboxSource {
  return { kind: "inbox", id: inboxRecordId(identity()), attempt: 0, purpose: "final", ordinal: 0 };
}

describe("durable message types", () => {
  it("derives stable, attempt-scoped inbox and outbox ids", () => {
    expect(inboxRecordId(identity())).toBe(inboxRecordId(identity()));
    expect(inboxRecordId(identity(), 1)).not.toBe(inboxRecordId(identity()));
    expect(outboxRecordId(source())).toBe(outboxRecordId(source()));
    expect(outboxRecordId({ ...source(), ordinal: 1 })).not.toBe(outboxRecordId(source()));
  });

  it("bounds persisted inbound and outbound text by UTF-8 bytes", () => {
    const text = "你".repeat(MAX_GATEWAY_MESSAGE_BYTES);
    const inbox = createInboxRecord(
      {
        identity: identity(),
        route: route(),
        message: {
          nativeMessageId: "message-42",
          senderId: "user-1",
          text,
          timestamp: NOW.toISOString(),
        },
      },
      NOW,
    );
    const outbox = createOutboxRecord({ source: source(), target: route().locator, text }, NOW);

    expect(inbox.message.textTruncated).toBe(true);
    expect(outbox.textTruncated).toBe(true);
    expect(Buffer.byteLength(inbox.message.text, "utf8")).toBeLessThanOrEqual(
      MAX_GATEWAY_MESSAGE_BYTES,
    );
    expect(Buffer.byteLength(outbox.text, "utf8")).toBeLessThanOrEqual(MAX_GATEWAY_MESSAGE_BYTES);
    expect(outbox.contentHash).toBe(messageContentHash(outbox.text));
  });

  it("requires retries to preserve ancestry while deriving a new id", () => {
    const parent = inboxRecordId(identity());
    const retry = createInboxRecord(
      {
        identity: identity(),
        route: route(),
        attempt: 1,
        parentMessageId: parent,
        message: {
          nativeMessageId: "message-42",
          senderId: "user-1",
          text: "retry",
          timestamp: NOW.toISOString(),
        },
      },
      NOW,
    );
    expect(retry.id).not.toBe(parent);
    expect(retry.parentMessageId).toBe(parent);
    expect(() =>
      createInboxRecord(
        {
          identity: identity(),
          route: route(),
          attempt: 1,
          message: {
            nativeMessageId: "message-42",
            senderId: "user-1",
            text: "retry",
            timestamp: NOW.toISOString(),
          },
        },
        NOW,
      ),
    ).toThrow(/parentMessageId/);
  });

  it("owns strict decode and transition validation centrally", () => {
    const inbox = createInboxRecord(
      {
        identity: identity(),
        route: route(),
        message: {
          nativeMessageId: "message-42",
          senderId: "user-1",
          text: "hello",
          timestamp: NOW.toISOString(),
        },
      },
      NOW,
    );
    const outbox = createOutboxRecord(
      { source: source(), target: route().locator, text: "hello" },
      NOW,
    );

    expect(() => decodeInboxRecord({ ...inbox, version: 2 })).toThrow(/unsupported/);
    expect(() => decodeInboxRecord({ ...inbox, route: { ...inbox.route, key: "wrong" } })).toThrow(
      /does not match/,
    );
    expect(() => decodeOutboxRecord({ ...outbox, contentHash: "tampered" })).toThrow(/mismatch/);
    expect(() =>
      decodeOutboxRecord({
        ...outbox,
        error: {
          code: "TRANSIENT_NETWORK",
          message: "x".repeat(MAX_MESSAGE_ERROR_BYTES + 1),
          retryable: true,
        },
      }),
    ).toThrow(/durable error limit/);
    expect(() => assertInboxTransition("received", "completed")).toThrow(/invalid/);
    expect(() => assertOutboxTransition("pending", "delivered")).toThrow(/invalid/);
    expect(() => assertInboxTransition("processing", "completed")).not.toThrow();
    expect(() => assertOutboxTransition("sending", "delivered")).not.toThrow();
  });

  it("marks alert deliveries as loop-suppressed while accepting legacy records", () => {
    const alert = createOutboxRecord(
      {
        source: { kind: "system", id: "alert-1", attempt: 0, purpose: "alert", ordinal: 0 },
        target: route().locator,
        text: "alert",
        suppressAlerts: true,
      },
      NOW,
    );
    expect(alert.suppressAlerts).toBe(true);
    expect(decodeOutboxRecord(alert).suppressAlerts).toBe(true);
    const legacy = { ...alert };
    delete legacy.suppressAlerts;
    expect(decodeOutboxRecord(legacy).suppressAlerts).toBeUndefined();
    expect(() => decodeOutboxRecord({ ...alert, suppressAlerts: false })).toThrow(/suppressAlerts/);
  });
});
