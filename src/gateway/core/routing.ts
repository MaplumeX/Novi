import type {
  ChannelAdapter,
  ChannelMessage,
  GatewaySessionLocator,
  GatewaySessionRoute,
  ChannelSendTarget,
} from "./types.js";

/** Canonical, unambiguous key for a durable gateway conversation locator. */
export function sessionKeyForLocator(locator: GatewaySessionLocator): string {
  const fields = [
    "gateway",
    locator.channel,
    locator.account,
    locator.chat.type,
    locator.chat.id,
  ].map(encodeURIComponent);
  if (locator.thread !== undefined) fields.push("thread", encodeURIComponent(locator.thread));
  return fields.join(":");
}

export function channelTargetForLocator(locator: GatewaySessionLocator): ChannelSendTarget {
  return {
    chatId: locator.chat.id,
    ...(locator.thread !== undefined ? { threadId: locator.thread } : {}),
  };
}

export function channelTargetForMessage(message: ChannelMessage): ChannelSendTarget {
  return {
    chatId: message.remoteChatId,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
  };
}

/** Build the durable route for one inbound channel message. */
export function sessionRoute(
  channel: Pick<ChannelAdapter, "id" | "type">,
  msg: ChannelMessage,
): GatewaySessionRoute {
  const locator: GatewaySessionLocator = {
    channel: channel.type,
    account: channel.id,
    chat: { type: msg.chatType, id: msg.remoteChatId },
    ...(msg.threadId !== undefined ? { thread: msg.threadId } : {}),
  };
  return { key: sessionKeyForLocator(locator), locator };
}

export function isSilentReply(text: string): boolean {
  return /^(silent|\[silent\]|no_reply|no reply)$/i.test(text.trim());
}

/** Bounded TTL dedupe store for channel update ids. */
export class InboundDeduper {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly ttlMs = 300_000,
    private readonly maxEntries = 10_000,
  ) {}
  seenBefore(key: string, now = Date.now()): boolean {
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    const existing = this.seen.get(key);
    if (existing && existing > now) return true;
    while (this.seen.size >= this.maxEntries) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, now + this.ttlMs);
    return false;
  }
}
