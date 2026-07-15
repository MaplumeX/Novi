import type {
  ChannelAdapter,
  ChannelDeliveryReceipt,
  ChannelSendTarget,
  GatewaySessionLocator,
} from "../core/types.js";
import { createOutboxRecord, type InboxRecord, type OutboxPurpose } from "./types.js";
import { GatewayMessageStore } from "./store.js";
import { OutboxDeliveryWorker } from "./outbox.js";

/** Creates deterministic durable final-delivery intents and wakes the outbox worker. */
export class FinalDeliverySink {
  constructor(
    private readonly store: GatewayMessageStore,
    private readonly worker: OutboxDeliveryWorker,
  ) {}

  forInbox(channel: ChannelAdapter, inbox: InboxRecord, purpose: OutboxPurpose): ChannelAdapter {
    return {
      id: channel.id,
      type: channel.type,
      capabilities: channel.capabilities,
      textChunkLimit: channel.textChunkLimit,
      onMessage: channel.onMessage,
      acknowledgeMessage: channel.acknowledgeMessage,
      start: () => channel.start(),
      stop: () => channel.stop(),
      send: (target, text) => this.enqueueInbox(inbox.id, target, text, purpose),
      ...(channel.sendFinalChunk === undefined
        ? {}
        : { sendFinalChunk: channel.sendFinalChunk.bind(channel) }),
      ...(channel.sendEvent === undefined ? {} : { sendEvent: channel.sendEvent.bind(channel) }),
      ...(channel.sendTyping === undefined ? {} : { sendTyping: channel.sendTyping.bind(channel) }),
      ...(channel.cancelStream === undefined
        ? {}
        : { cancelStream: channel.cancelStream.bind(channel) }),
      ...(channel.probe === undefined ? {} : { probe: channel.probe.bind(channel) }),
    };
  }

  async enqueueSystem(
    channel: Pick<ChannelAdapter, "id" | "type">,
    target: GatewaySessionLocator,
    sourceId: string,
    text: string,
    purpose: OutboxPurpose,
    suppressAlerts = false,
  ): Promise<ChannelDeliveryReceipt> {
    const outbox = createOutboxRecord({
      source: { kind: "system", id: sourceId, attempt: 0, purpose, ordinal: 0 },
      target: { ...target, channel: channel.type, account: channel.id },
      text,
      suppressAlerts,
    });
    const created = await this.store.createOutbox(outbox);
    this.worker.kick();
    return { messageIds: [created.record.id] };
  }

  private async enqueueInbox(
    inboxId: string,
    target: ChannelSendTarget,
    text: string,
    purpose: OutboxPurpose,
  ): Promise<ChannelDeliveryReceipt> {
    const inbox = this.store.getInbox(inboxId);
    if (!inbox) throw new Error(`inbox record not found for delivery: ${inboxId}`);
    const ordinal = inbox.deliveryIds.length;
    const locator: GatewaySessionLocator = {
      ...inbox.route.locator,
      chat: { ...inbox.route.locator.chat, id: target.chatId },
      ...(target.threadId === undefined ? {} : { thread: target.threadId }),
      ...(target.replyToMessageId === undefined ? {} : { replyTo: target.replyToMessageId }),
    };
    const outbox = createOutboxRecord({
      source: {
        kind: "inbox",
        id: inbox.id,
        attempt: inbox.attempt,
        purpose,
        ordinal,
      },
      target: locator,
      text,
    });
    const created = await this.store.createOutbox(outbox);
    if (!inbox.deliveryIds.includes(created.record.id)) {
      await this.store.updateInbox(inbox.id, (current) => ({
        ...current,
        deliveryIds: [...current.deliveryIds, created.record.id],
      }));
    }
    this.worker.kick();
    return { messageIds: [created.record.id] };
  }
}
