import { Telegraf, TelegramError } from "telegraf";
import { message } from "telegraf/filters";
import type { Chat as TgChat, User as TgUser } from "@telegraf/types";
import { AbstractChannel } from "../core/abstract-channel.js";
import type { ChannelCapabilities, ChannelEvent, ChannelMessage, ChatType } from "../core/types.js";

/** Constructor options for {@link TelegramChannel}. */
export interface TelegramChannelOptions {
  /** Stable instance id (used in session keys). */
  id: string;
  /** Bot token from gateway.json (after `${ENV}` expansion). */
  botToken: string;
  /** Minimum interval between edit-message calls (default 1000 ms). */
  editIntervalMs?: number;
}

/** Per-chat streaming buffer: holds the placeholder message id and accumulated text. */
interface StreamBuffer {
  messageId: number;
  text: string;
  lastEdit: number;
}

/** Telegram hard limit per message (UTF-16 code units). */
const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Telegram channel adapter (long-polling).
 *
 * MVP handles private chats only. Streaming replies are rendered via
 * `sendMessage` (placeholder) + throttled `editMessageText`, matching the
 * `edit: true` capability. Final text is flushed in {@link send}; overflow is
 * split into multiple messages by UTF-16 length (design.md §4).
 */
export class TelegramChannel extends AbstractChannel {
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group", "channel", "thread"],
    edit: true,
    markdown: true,
    blockStreaming: true,
  };
  readonly textChunkLimit = TELEGRAM_TEXT_LIMIT;

  private readonly bot: Telegraf;
  private readonly editIntervalMs: number;
  private readonly streamBuffers = new Map<string, StreamBuffer>();

  constructor(options: TelegramChannelOptions) {
    super(options.id, "telegram");
    this.bot = new Telegraf(options.botToken);
    this.editIntervalMs = options.editIntervalMs ?? 1000;
  }

  async start(): Promise<void> {
    this.bot.on(message("text"), (ctx) => {
      const tgMsg = ctx.message;
      const chat = ctx.chat as TgChat | undefined;
      const from = tgMsg.from as TgUser | undefined;
      // MVP: only handle private chats.
      if (!chat || chat.type !== "private") return;
      if (!from) return;

      void this.emitMessage(this.normalizeMessage(chat, tgMsg, from));
    });

    await this.bot.launch();
  }

  async stop(): Promise<void> {
    // `bot.stop` throws "Bot is not running!" when never launched or already
    // stopped — guard against that (mirrors tia-gateway).
    try {
      this.bot.stop("gateway-shutdown");
    } catch {
      // Not running — nothing to do.
    }
  }

  /** Send the final, complete reply text (chunking on overflow). */
  async send(chatId: string, text: string): Promise<void> {
    const buf = this.streamBuffers.get(chatId);
    if (buf) {
      // Edit the streaming placeholder to the final text.
      await this.editOrRetry(chatId, buf.messageId, text.slice(0, TELEGRAM_TEXT_LIMIT));
      // Flush any overflow beyond the first message.
      const overflow = text.slice(TELEGRAM_TEXT_LIMIT);
      if (overflow.length > 0) {
        for (const chunk of chunkText(overflow, TELEGRAM_TEXT_LIMIT)) {
          await this.sendOrRetry(chatId, chunk);
        }
      }
      this.streamBuffers.delete(chatId);
      return;
    }

    // No streaming buffer — chunk the whole text.
    for (const chunk of chunkText(text, TELEGRAM_TEXT_LIMIT)) {
      await this.sendOrRetry(chatId, chunk);
    }
  }

  /** Stream an incremental event. Only `text-delta`/`typing` are handled. */
  async sendEvent(chatId: string, event: ChannelEvent): Promise<void> {
    switch (event.type) {
      case "typing":
        await this.bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
        break;
      case "text-delta":
        await this.handleStreamDelta(chatId, event.delta);
        break;
      case "tool-call":
        // MVP: keep tool status minimal — send a short notice.
        await this.sendOrRetry(chatId, `🔧 ${event.toolName}…`).catch(() => {});
        break;
      case "reasoning-delta":
        // Reasoning is not surfaced to the channel in MVP.
        break;
      case "error":
        await this.sendOrRetry(chatId, `⚠️ ${event.message}`).catch(() => {});
        break;
    }
  }

  /** Best-effort typing indicator. */
  async sendTyping(chatId: string): Promise<void> {
    await this.bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Map a Telegram text message into a {@link ChannelMessage}. */
  private normalizeMessage(
    chat: TgChat,
    tgMsg: {
      message_id: number;
      date: number;
      text: string;
      reply_to_message?: { message_id: number };
    },
    from: TgUser,
  ): ChannelMessage {
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(" ") || undefined;
    return {
      id: String(tgMsg.message_id),
      remoteChatId: String(chat.id),
      chatType: mapChatType(chat.type),
      senderId: String(from.id),
      senderName,
      senderUsername: from.username,
      text: tgMsg.text,
      timestamp: new Date(tgMsg.date * 1000),
      replyToMessageId: tgMsg.reply_to_message
        ? String(tgMsg.reply_to_message.message_id)
        : undefined,
      metadata: { telegramChatType: chat.type, telegramMessageId: tgMsg.message_id },
    };
  }

  /**
   * Accumulate a text delta and throttle `editMessageText` by
   * {@link editIntervalMs}. The first delta sends a placeholder message to
   * obtain a message id; subsequent deltas edit it.
   */
  private async handleStreamDelta(chatId: string, delta: string): Promise<void> {
    let buf = this.streamBuffers.get(chatId);
    if (!buf) {
      buf = { messageId: 0, text: "", lastEdit: 0 };
      this.streamBuffers.set(chatId, buf);
    }
    buf.text += delta;

    if (!buf.messageId) {
      const sent = await this.sendOrRetry(chatId, buf.text.slice(0, TELEGRAM_TEXT_LIMIT));
      buf.messageId = sent;
      buf.lastEdit = Date.now();
      return;
    }

    const now = Date.now();
    if (now - buf.lastEdit >= this.editIntervalMs) {
      await this.editOrRetry(chatId, buf.messageId, buf.text.slice(0, TELEGRAM_TEXT_LIMIT));
      buf.lastEdit = now;
    }
  }

  /**
   * Send a message, retrying once after a FloodWait delay. Returns the
   * Telegram message id (needed for edit-stream bookkeeping).
   */
  private async sendOrRetry(chatId: string, text: string): Promise<number> {
    try {
      const sent = await this.bot.telegram.sendMessage(chatId, text);
      return sent.message_id;
    } catch (e) {
      const retryAfter = readRetryAfter(e);
      if (retryAfter !== undefined) {
        await delay(retryAfter * 1000);
        const sent = await this.bot.telegram.sendMessage(chatId, text);
        return sent.message_id;
      }
      throw e;
    }
  }

  /** Edit a message, retrying once after a FloodWait delay. */
  private async editOrRetry(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.bot.telegram.editMessageText(chatId, messageId, undefined, text);
    } catch (e) {
      // "message is not modified" happens when the throttled text equals the
      // last sent text — swallow it to avoid noise.
      if (isMessageNotModified(e)) return;
      const retryAfter = readRetryAfter(e);
      if (retryAfter !== undefined) {
        await delay(retryAfter * 1000);
        await this.bot.telegram.editMessageText(chatId, messageId, undefined, text).catch(() => {});
        return;
      }
      // Best-effort: don't let an edit failure crash the turn.
      process.stderr.write(
        `warning: telegram editMessageText failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a Telegram chat type string to the gateway {@link ChatType} union. */
function mapChatType(type: string): ChatType {
  switch (type) {
    case "private":
      return "direct";
    case "group":
    case "supergroup":
      return "group";
    case "channel":
      return "channel";
    default:
      return "direct";
  }
}

/** Return the `retry_after` (seconds) from a Telegram FloodWait error, if any. */
function readRetryAfter(e: unknown): number | undefined {
  if (e instanceof TelegramError) {
    return e.parameters?.retry_after;
  }
  // telegraf wraps some errors; check a generic shape too.
  const params = (e as { parameters?: { retry_after?: number } } | null)?.parameters;
  return params?.retry_after;
}

/** Detect the "message is not modified" Telegram error. */
function isMessageNotModified(e: unknown): boolean {
  return e instanceof TelegramError && e.description.includes("not modified");
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split `text` into chunks no longer than `limit` UTF-16 code units.
 *
 * Surrogate pairs are never split: if the boundary lands at a low surrogate
 * (i.e. the preceding code unit is its high surrogate), the chunk is shortened
 * by one so the pair stays intact. This matches the Telegram 4096-UTF-16-unit
 * limit (design.md §4).
 */
export function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + limit;
    if (end > text.length) end = text.length;
    // Avoid splitting a surrogate pair: if the code unit at `end` is a low
    // surrogate, `end-1` is its high surrogate — back up one so the pair
    // stays in the previous chunk.
    if (end < text.length) {
      const code = text.charCodeAt(end);
      if (code >= 0xdc00 && code <= 0xdfff) {
        end -= 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [""];
}
