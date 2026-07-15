import type { ChannelAdapter, ChannelMessage, GatewaySessionRoute } from "../core/types.js";
import { sessionKeyForLocator } from "../core/routing.js";
import {
  createInboxRecord,
  createOutboxRecord,
  type InboxRecord,
  type OutboxRecord,
} from "./types.js";
import { GatewayMessageStore } from "./store.js";

/** Durable acceptance boundary used before a polling transport advances its offset. */
export class GatewayMessageService {
  constructor(
    private readonly store: GatewayMessageStore,
    private readonly onInboxReady?: (routeKey: string) => void,
    private readonly onOutboxReady?: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async accept(
    channel: Pick<ChannelAdapter, "id" | "type">,
    message: ChannelMessage,
    route: GatewaySessionRoute,
  ): Promise<{ record: InboxRecord; created: boolean }> {
    const nativeUpdateId = String(message.metadata?.updateId ?? message.id);
    return this.store.createInbox(
      createInboxRecord({
        identity: { channel: channel.type, account: channel.id, nativeUpdateId },
        route,
        message: {
          nativeMessageId: message.id,
          senderId: message.senderId,
          ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
          ...(message.senderUsername === undefined
            ? {}
            : { senderUsername: message.senderUsername }),
          text: message.text,
          timestamp: message.timestamp.toISOString(),
          ...(message.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: message.replyToMessageId }),
        },
      }),
    );
  }

  list(route?: GatewaySessionRoute): Array<InboxRecord | OutboxRecord> {
    const inbox = this.store
      .listInbox()
      .filter((record) => route === undefined || record.route.key === route.key);
    const outbox = this.store
      .listOutbox()
      .filter((record) => route === undefined || sessionKeyForLocator(record.target) === route.key);
    return [...inbox, ...outbox].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    );
  }

  async retry(route: GatewaySessionRoute, id: string): Promise<InboxRecord> {
    const original = this.routeInbox(route, id);
    if (original.status !== "interrupted" && original.status !== "failed") {
      throw new Error(`message is not retryable: ${id}`);
    }
    const attempt =
      Math.max(
        ...this.store
          .listInbox()
          .filter(
            (record) =>
              record.identity.channel === original.identity.channel &&
              record.identity.account === original.identity.account &&
              record.identity.nativeUpdateId === original.identity.nativeUpdateId,
          )
          .map((record) => record.attempt),
      ) + 1;
    const message = {
      nativeMessageId: original.message.nativeMessageId,
      senderId: original.message.senderId,
      ...(original.message.senderName === undefined
        ? {}
        : { senderName: original.message.senderName }),
      ...(original.message.senderUsername === undefined
        ? {}
        : { senderUsername: original.message.senderUsername }),
      text: original.message.text,
      timestamp: original.message.timestamp,
      ...(original.message.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: original.message.replyToMessageId }),
    };
    const retryRecord = createInboxRecord(
      {
        identity: original.identity,
        route: original.route,
        message,
        attempt,
        parentMessageId: original.id,
      },
      this.now(),
    );
    retryRecord.message.textTruncated = original.message.textTruncated;
    const created = await this.store.createInbox(retryRecord);
    this.onInboxReady?.(route.key);
    return created.record;
  }

  async retryDelivery(route: GatewaySessionRoute, id: string): Promise<OutboxRecord> {
    const original = this.routeOutbox(route, id);
    if (original.status !== "delivery_failed") {
      throw new Error(`delivery is not retryable: ${id}`);
    }
    const ordinal =
      Math.max(
        -1,
        ...this.store
          .listOutbox()
          .filter(
            (record) =>
              record.source.kind === original.source.kind &&
              record.source.id === original.source.id &&
              record.source.attempt === original.source.attempt &&
              record.source.purpose === original.source.purpose,
          )
          .map((record) => record.source.ordinal),
      ) + 1;
    const created = await this.store.createOutbox(
      createOutboxRecord(
        {
          source: { ...original.source, ordinal },
          target: original.target,
          text: original.text,
          maxAttempts: original.maxAttempts,
        },
        this.now(),
      ),
    );
    if (original.source.kind === "inbox") {
      const inbox = this.store.getInbox(original.source.id);
      if (inbox && !inbox.deliveryIds.includes(created.record.id)) {
        await this.store.updateInbox(inbox.id, (current) => ({
          ...current,
          deliveryIds: [...current.deliveryIds, created.record.id],
        }));
      }
    }
    this.onOutboxReady?.();
    return created.record;
  }

  async dismiss(id: string, route?: GatewaySessionRoute): Promise<InboxRecord | OutboxRecord> {
    const inbox = this.store.getInbox(id);
    if (inbox && (route === undefined || inbox.route.key === route.key)) {
      if (inbox.status === "received" || inbox.status === "processing") {
        throw new Error(`cannot dismiss active inbox record: ${id}`);
      }
      return this.store.updateInbox(id, (current) => ({
        ...current,
        status: "dismissed",
        finishedAt: current.finishedAt ?? this.now().toISOString(),
      }));
    }
    const outbox = this.store.getOutbox(id);
    if (outbox && (route === undefined || sessionKeyForLocator(outbox.target) === route.key)) {
      if (outbox.status === "pending" || outbox.status === "sending") {
        throw new Error(`cannot dismiss active outbox record: ${id}`);
      }
      return this.store.updateOutbox(id, (current) => ({
        ...current,
        status: "dismissed",
        finishedAt: current.finishedAt ?? this.now().toISOString(),
      }));
    }
    throw new Error(`message record not found: ${id}`);
  }

  private routeInbox(route: GatewaySessionRoute, id: string): InboxRecord {
    const record = this.store.getInbox(id);
    if (!record || record.route.key !== route.key)
      throw new Error(`message record not found: ${id}`);
    return record;
  }

  private routeOutbox(route: GatewaySessionRoute, id: string): OutboxRecord {
    const record = this.store.getOutbox(id);
    if (!record || sessionKeyForLocator(record.target) !== route.key) {
      throw new Error(`message record not found: ${id}`);
    }
    return record;
  }
}
