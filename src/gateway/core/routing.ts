import type { ChannelMessage } from "./types.js";

/** Stable session identity; topics never share a harness with their parent chat. */
export function sessionKey(channelId: string, msg: ChannelMessage): string {
  return `${channelId}:${msg.chatType}:${msg.remoteChatId}${msg.threadId ? `:thread:${msg.threadId}` : ""}`;
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
