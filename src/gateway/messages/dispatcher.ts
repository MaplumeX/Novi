import type { ChannelAdapter, ChannelMessage } from "../core/types.js";
import { redactAndBoundError } from "./errors.js";
import { GatewayMessageStore } from "./store.js";
import type { InboxRecord } from "./types.js";
import type { GatewayMetrics } from "../runtime/metrics.js";
import type { GatewayLogger } from "../runtime/logger.js";

export type DurableInboxHandler = (
  channel: ChannelAdapter,
  message: ChannelMessage,
  record: InboxRecord,
) => Promise<void>;

/** Claims durable inbox records one-at-a-time per route and records every outcome. */
export class GatewayMessageDispatcher {
  private readonly channels = new Map<string, ChannelAdapter>();
  private readonly active = new Map<string, Promise<void>>();
  private stopping = true;
  private failure: Error | undefined;

  constructor(
    channels: readonly ChannelAdapter[],
    private readonly store: GatewayMessageStore,
    private readonly handler: DurableInboxHandler,
    private readonly now: () => Date = () => new Date(),
    private readonly onInterrupted?: (record: InboxRecord) => Promise<void>,
    private readonly metrics?: GatewayMetrics,
    private readonly logger?: GatewayLogger,
  ) {
    for (const channel of channels) this.channels.set(`${channel.type}:${channel.id}`, channel);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.failure = undefined;
    for (const record of this.store.listInbox()) {
      if (record.status !== "processing") continue;
      const hasFinalOutbox = this.store
        .listOutbox()
        .some(
          (outbox) =>
            record.deliveryIds.includes(outbox.id) ||
            (outbox.source.kind === "inbox" && outbox.source.id === record.id),
        );
      const recovered = await this.store.updateInbox(record.id, (current) => ({
        ...current,
        status: hasFinalOutbox ? "completed" : "interrupted",
        finishedAt: this.now().toISOString(),
        ...(hasFinalOutbox
          ? { error: undefined }
          : {
              error: {
                code: "PROCESS_INTERRUPTED",
                message: "Gateway stopped while processing this message",
                retryable: false,
              },
            }),
      }));
      if (!hasFinalOutbox) {
        this.metrics?.increment("ingressInterrupted");
        this.logger?.warn("gateway.ingress.recovered_interrupted", { messageId: recovered.id });
        await this.onInterrupted?.(recovered);
      }
    }
    for (const routeKey of new Set(
      this.store
        .listInbox()
        .filter((record) => record.status === "received")
        .map((record) => record.route.key),
    )) {
      this.kick(routeKey);
    }
  }

  kick(routeKey: string): void {
    if (this.stopping || this.active.has(routeKey)) return;
    const task = this.drain(routeKey)
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.stopping = true;
        this.logger?.error("gateway.worker.inbox_failed", error);
      })
      .finally(() => {
        this.active.delete(routeKey);
        if (!this.stopping && this.nextReceived(routeKey)) this.kick(routeKey);
      });
    this.active.set(routeKey, task);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.active.values()]);
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  private async drain(routeKey: string): Promise<void> {
    while (!this.stopping) {
      const next = this.nextReceived(routeKey);
      if (!next) return;
      const channel = this.channels.get(`${next.identity.channel}:${next.identity.account}`);
      if (!channel) {
        await this.store.updateInbox(next.id, (current) => ({
          ...current,
          status: "failed",
          finishedAt: this.now().toISOString(),
          error: {
            code: "CHANNEL_UNAVAILABLE",
            message: "inbound channel is unavailable",
            retryable: false,
          },
        }));
        continue;
      }
      const claimed = await this.store.updateInbox(next.id, (current) => ({
        ...current,
        status: "processing",
        startedAt: this.now().toISOString(),
        error: undefined,
      }));
      try {
        await this.handler(channel, restoreMessage(claimed), claimed);
        const current = this.store.getInbox(claimed.id);
        if (current?.status === "processing") {
          await this.store.updateInbox(claimed.id, (record) => ({
            ...record,
            status: "completed",
            finishedAt: this.now().toISOString(),
          }));
        }
      } catch (error) {
        const current = this.store.getInbox(claimed.id);
        if (current?.status === "processing") {
          await this.store.updateInbox(claimed.id, (record) => ({
            ...record,
            status: "failed",
            finishedAt: this.now().toISOString(),
            error: {
              code: "INBOUND_DISPATCH_FAILED",
              message: redactAndBoundError(error),
              retryable: false,
            },
          }));
        }
      }
    }
  }

  private nextReceived(routeKey: string): InboxRecord | undefined {
    return this.store
      .listInbox()
      .filter((record) => record.route.key === routeKey && record.status === "received")
      .sort(compareDispatchOrder)[0];
  }
}

function compareDispatchOrder(left: InboxRecord, right: InboxRecord): number {
  if (
    left.identity.channel === "telegram" &&
    right.identity.channel === "telegram" &&
    left.identity.account === right.identity.account
  ) {
    const leftUpdate = Number(left.identity.nativeUpdateId);
    const rightUpdate = Number(right.identity.nativeUpdateId);
    if (Number.isSafeInteger(leftUpdate) && Number.isSafeInteger(rightUpdate)) {
      return leftUpdate - rightUpdate;
    }
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function restoreMessage(record: InboxRecord): ChannelMessage {
  return {
    id: record.message.nativeMessageId,
    remoteChatId: record.route.locator.chat.id,
    chatType: record.route.locator.chat.type,
    senderId: record.message.senderId,
    ...(record.message.senderName === undefined ? {} : { senderName: record.message.senderName }),
    ...(record.message.senderUsername === undefined
      ? {}
      : { senderUsername: record.message.senderUsername }),
    text: record.message.text,
    timestamp: new Date(record.message.timestamp),
    ...(record.route.locator.thread === undefined ? {} : { threadId: record.route.locator.thread }),
    ...(record.message.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: record.message.replyToMessageId }),
    metadata: { updateId: record.identity.nativeUpdateId },
  };
}
