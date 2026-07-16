import {
  createLarkChannel,
  LarkChannel,
  LoggerLevel,
  type Domain,
  type NormalizedMessage,
  type SendResult,
} from "@larksuiteoapi/node-sdk";
import { AbstractChannel } from "../core/abstract-channel.js";
import { chunkText } from "../core/text.js";
import type {
  ChannelCapabilities,
  ChannelChunkReceipt,
  ChannelDeliveryReceipt,
  ChannelMessage,
  ChannelSendTarget,
  ChatType,
} from "../core/types.js";
import type { GatewayLogger } from "../runtime/logger.js";

/** Constructor options for {@link FeishuChannel}. */
export interface FeishuChannelOptions {
  /** Stable instance id (used in session keys). */
  id: string;
  /** Feishu App ID. */
  appId: string;
  /** Feishu App Secret. */
  appSecret: string;
  /** Feishu domain: "feishu" (default, domestic) or "lark" (overseas). */
  domain?: Domain | string;
  /** Injectable factory for the SDK LarkChannel (testing). */
  larkChannelFactory?: LarkChannelFactory;
  logger?: GatewayLogger;
}

/**
 * Minimal interface of the SDK `LarkChannel` surface used by this adapter.
 * Allows injecting a mock in tests without depending on the real WebSocket.
 */
export interface LarkChannelLike {
  on(
    name: "message",
    handler: (msg: NormalizedMessage) => void | Promise<void>,
  ): () => void;
  on(name: "error", handler: (err: unknown) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(to: string, input: { markdown: string } | { text: string }, opts?: unknown): Promise<SendResult>;
  botIdentity?: { openId: string; name: string };
}

/** Injectable factory that creates a {@link LarkChannelLike}. */
export type LarkChannelFactory = (opts: {
  appId: string;
  appSecret: string;
  domain?: Domain | string;
  policy: { requireMention: false; dmMode: "open" };
  loggerLevel: LoggerLevel;
}) => LarkChannelLike;

/** Conservative chunk limit for Feishu text messages (UTF-16 code units). */
const FEISHU_TEXT_LIMIT = 4000;

/**
 * Feishu (Lark) channel adapter using the official SDK `Channel` module.
 *
 * Uses WebSocket long-connection. The SDK's policy layer is disabled
 * (`requireMention: false`, `dmMode: "open"`) so GatewayApp owns auth/dedup.
 *
 * Key capability differences from Telegram (validating the abstraction):
 * - `edit: false` — Feishu text messages don't support edit-stream; no
 *   `sendEvent` implementation.
 * - `threads: false` — thread/topic mapping not done this round; `threadId`
 *   is safely ignored.
 * - `media: false` — D8: no Feishu media in/out.
 */
export class FeishuChannel extends AbstractChannel {
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group"],
    edit: false,
    threads: false,
    markdown: true,
    media: false,
    blockStreaming: false,
  };
  readonly textChunkLimit = FEISHU_TEXT_LIMIT;

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly domain: Domain | string | undefined;
  private readonly factory: LarkChannelFactory;
  private readonly logger: GatewayLogger | undefined;
  private channel: LarkChannelLike | undefined;
  private failure: Error | undefined;

  constructor(options: FeishuChannelOptions) {
    super(options.id, "feishu");
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.domain = options.domain;
    this.logger = options.logger;
    this.factory = options.larkChannelFactory ?? defaultLarkChannelFactory;
  }

  async start(): Promise<void> {
    if (this.channel) throw new Error("Feishu channel is already running");
    const channel = this.factory({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      policy: { requireMention: false, dmMode: "open" },
      loggerLevel: LoggerLevel.warn,
    });
    channel.on("message", (msg) => this.handleMessage(msg));
    channel.on("error", (err) => {
      this.failure = err instanceof Error ? err : new Error(String(err));
      if (this.logger) {
        this.logger.error("gateway.channel.feishu_error", { channel: this.id, error: String(err) });
      }
    });
    await channel.connect();
    this.channel = channel;
    this.failure = undefined;
  }

  async stop(): Promise<void> {
    const ch = this.channel;
    if (!ch) return;
    this.channel = undefined;
    await ch.disconnect();
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.channel) return { ok: false, detail: "not connected" };
    const identity = this.channel.botIdentity;
    return identity ? { ok: true, detail: identity.name } : { ok: true, detail: "connected" };
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  /** Send the final, complete reply text (chunking on overflow). */
  async send(target: ChannelSendTarget, text: string): Promise<ChannelDeliveryReceipt> {
    const messageIds: string[] = [];
    for (const chunk of chunkText(text, FEISHU_TEXT_LIMIT)) {
      const result = await this.sendChunk(target, chunk);
      messageIds.push(result.messageId);
    }
    return { messageIds };
  }

  /** One durable final-send API call for a single chunk. */
  async sendFinalChunk(
    target: ChannelSendTarget,
    text: string,
    _ordinal: number,
  ): Promise<ChannelChunkReceipt> {
    void _ordinal;
    const result = await this.sendChunk(target, text);
    return { messageId: result.messageId };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Fire-and-forget inbound handler. The Feishu long-connection requires
   * processing within 3 seconds or the message is re-pushed. We emit
   * immediately without awaiting downstream — durable inbox is the safety net.
   */
  private handleMessage(msg: NormalizedMessage): void {
    void this.emitMessage(this.normalizeMessage(msg));
  }

  /** Send one chunk, using reply API when `replyToMessageId` is present. */
  private async sendChunk(
    target: ChannelSendTarget,
    text: string,
  ): Promise<{ messageId: string }> {
    if (!this.channel) throw new Error("Feishu channel not started");
    const opts: { replyTo?: string } = target.replyToMessageId
      ? { replyTo: target.replyToMessageId }
      : {};
    const result = await this.channel.send(target.chatId, { markdown: text }, opts);
    return { messageId: result.messageId };
  }

  /** Map a SDK NormalizedMessage into a gateway {@link ChannelMessage}. */
  private normalizeMessage(msg: NormalizedMessage): ChannelMessage {
    const chatType: ChatType = msg.chatType === "p2p" ? "direct" : "group";
    const isText = msg.rawContentType === "text";

    const base: ChannelMessage = {
      id: msg.messageId,
      remoteChatId: msg.chatId,
      chatType,
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      text: msg.content,
      timestamp: new Date(msg.createTime),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      metadata: {
        feishuChatType: msg.chatType,
        feishuMessageId: msg.messageId,
        feishuRawContentType: msg.rawContentType,
        mentionedBot: msg.mentionedBot,
        updateId: msg.messageId,
        ...(!isText ? { unsupported: msg.rawContentType } : {}),
      },
    };

    // Non-text messages: provide a diagnostic text so the agent can see it.
    if (!isText) {
      base.text = `[unsupported message type: ${msg.rawContentType}]`;
    }

    return base;
  }
}

/** Default factory using the real SDK `createLarkChannel`. */
const defaultLarkChannelFactory: LarkChannelFactory = (opts) => {
  return createLarkChannel({
    appId: opts.appId,
    appSecret: opts.appSecret,
    ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
    policy: opts.policy,
    loggerLevel: opts.loggerLevel,
  }) as unknown as LarkChannelLike;
};

// Re-export for tests that need to reference the type.
export type { LarkChannel };