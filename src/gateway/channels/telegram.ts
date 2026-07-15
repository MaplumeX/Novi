import { Telegraf, TelegramError } from "telegraf";
import { message } from "telegraf/filters";
import { AbortController, type AbortSignal } from "abort-controller";
import type {
  Chat as TgChat,
  Update as TgUpdate,
  User as TgUser,
  UserFromGetMe,
} from "@telegraf/types";
import { AbstractChannel } from "../core/abstract-channel.js";
import { chunkText } from "../core/text.js";
import type {
  ChannelCapabilities,
  ChannelDeliveryReceipt,
  ChannelEvent,
  ChannelMessage,
  ChannelSendTarget,
  ChatType,
} from "../core/types.js";
import { classifyChannelError } from "../messages/errors.js";
import type { GatewayLogger } from "../runtime/logger.js";

/** Constructor options for {@link TelegramChannel}. */
export interface TelegramChannelOptions {
  /** Stable instance id (used in session keys). */
  id: string;
  /** Bot token from gateway.json (after `${ENV}` expansion). */
  botToken: string;
  /** Minimum interval between edit-message calls (default 1000 ms). */
  editIntervalMs?: number;
  pollingApi?: TelegramPollingApi;
  logger?: GatewayLogger;
}

export interface TelegramPollingApi {
  getMe(): Promise<UserFromGetMe>;
  deleteWebhook(): Promise<unknown>;
  getUpdates(offset: number, signal: AbortSignal): Promise<TgUpdate[]>;
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
  private readonly pollingApi: TelegramPollingApi;
  private readonly streamBuffers = new Map<string, StreamBuffer>();
  private botUserId: number | undefined;
  private botUsername: string | undefined;
  private pollAbort: AbortController | undefined;
  private pollTask: Promise<void> | undefined;
  private pollFailure: Error | undefined;
  private handlersRegistered = false;
  private readonly logger: GatewayLogger | undefined;

  constructor(options: TelegramChannelOptions) {
    super(options.id, "telegram");
    this.bot = new Telegraf(options.botToken);
    this.bot.catch((error) => {
      throw error;
    });
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.logger = options.logger;
    this.pollingApi = options.pollingApi ?? {
      getMe: () => this.bot.telegram.getMe(),
      deleteWebhook: () => this.bot.telegram.deleteWebhook({ drop_pending_updates: false }),
      getUpdates: (offset, signal) =>
        this.bot.telegram.callApi(
          "getUpdates",
          { timeout: 30, limit: 100, offset, allowed_updates: ["message"] },
          { signal },
        ),
    };
  }

  async start(): Promise<void> {
    if (this.pollTask) throw new Error("Telegram polling is already running");
    if (!this.handlersRegistered) {
      this.handlersRegistered = true;
      this.bot.on(message("text"), async (ctx) => {
        const tgMsg = ctx.message;
        const chat = ctx.chat as TgChat | undefined;
        const from = tgMsg.from as TgUser | undefined;
        if (
          !chat ||
          (chat.type !== "private" && chat.type !== "group" && chat.type !== "supergroup")
        )
          return;
        if (!from) return;
        await this.emitMessage(this.normalizeMessage(chat, tgMsg, from, ctx.update.update_id));
      });
    }

    const me = await this.pollingApi.getMe();
    this.botUserId = me.id;
    this.botUsername = me.username;
    this.bot.botInfo = me;
    await this.pollingApi.deleteWebhook();
    const abort = new AbortController();
    this.pollAbort = abort;
    this.pollFailure = undefined;
    this.pollTask = this.poll(abort.signal).catch((error) => {
      if (!isAbortError(error)) {
        this.pollFailure = error instanceof Error ? error : new Error(String(error));
        if (this.logger) {
          this.logger.error("gateway.channel.polling_stopped", error, { channel: this.id });
        } else {
          process.stderr.write(
            `warning: telegram polling stopped: ${telegramErrorSummary(error)}\n`,
          );
        }
      }
    });
  }

  getFailure(): Error | undefined {
    return this.pollFailure;
  }

  async stop(): Promise<void> {
    this.pollAbort?.abort();
    await this.pollTask;
    this.pollAbort = undefined;
    this.pollTask = undefined;
  }

  /** Send the final, complete reply text (chunking on overflow). */
  async send(target: ChannelSendTarget, text: string): Promise<ChannelDeliveryReceipt> {
    const key = targetKey(target);
    const ids: string[] = [];
    const buf = this.streamBuffers.get(key);
    if (buf) {
      // Edit the streaming placeholder to the final text.
      await this.editOrRetry(target.chatId, buf.messageId, text.slice(0, TELEGRAM_TEXT_LIMIT));
      ids.push(String(buf.messageId));
      // Flush any overflow beyond the first message.
      const overflow = text.slice(TELEGRAM_TEXT_LIMIT);
      if (overflow.length > 0) {
        for (const chunk of chunkText(overflow, TELEGRAM_TEXT_LIMIT)) {
          ids.push(String(await this.sendOrRetry(target, chunk)));
        }
      }
      this.streamBuffers.delete(key);
      return { messageIds: ids };
    }

    // No streaming buffer — chunk the whole text.
    for (const chunk of chunkText(text, TELEGRAM_TEXT_LIMIT)) {
      ids.push(String(await this.sendOrRetry(target, chunk)));
    }
    return { messageIds: ids };
  }

  /** One durable final-send API call. Retry ownership stays with the outbox worker. */
  async sendFinalChunk(
    target: ChannelSendTarget,
    text: string,
    ordinal: number,
  ): Promise<{ messageId: string }> {
    const key = targetKey(target);
    const buffer = ordinal === 0 ? this.streamBuffers.get(key) : undefined;
    if (buffer?.messageId) {
      try {
        await this.bot.telegram.editMessageText(target.chatId, buffer.messageId, undefined, text);
      } catch (error) {
        if (!isMessageNotModified(error)) throw error;
      }
      this.streamBuffers.delete(key);
      return { messageId: String(buffer.messageId) };
    }
    const sent = await this.bot.telegram.sendMessage(
      target.chatId,
      text,
      telegramThreadExtra(target),
    );
    return { messageId: String(sent.message_id) };
  }

  /** Stream an incremental event. Only `text-delta`/`typing` are handled. */
  async sendEvent(target: ChannelSendTarget, event: ChannelEvent): Promise<void> {
    switch (event.type) {
      case "typing":
        await this.sendTyping(target);
        break;
      case "text-delta":
        await this.handleStreamDelta(target, event.delta);
        break;
      case "tool-event":
        // Keep channel rendering minimal while retaining the shared contract.
        if (event.event.type === "tool.start") {
          await this.sendOrRetry(target, `🔧 ${event.event.tool.label}…`).catch(() => {});
        }
        break;
      case "reasoning-delta":
        // Reasoning is not surfaced to the channel in MVP.
        break;
      case "error":
        await this.sendOrRetry(target, `⚠️ ${event.message}`).catch(() => {});
        break;
    }
  }

  /** Best-effort typing indicator. */
  async sendTyping(target: ChannelSendTarget): Promise<void> {
    await this.callWithRetry("sendChatAction", () =>
      this.bot.telegram.sendChatAction(target.chatId, "typing", telegramThreadExtra(target)),
    ).catch((e) => {
      if (this.logger) {
        this.logger.warn("gateway.channel.typing_failed", {
          channel: this.id,
          error: classifyChannelError(e),
        });
      } else {
        process.stderr.write(
          `warning: telegram sendChatAction failed: ${telegramErrorSummary(e)}\n`,
        );
      }
    });
  }

  async cancelStream(target: ChannelSendTarget): Promise<void> {
    const key = targetKey(target);
    const buffer = this.streamBuffers.get(key);
    if (!buffer) return;
    this.streamBuffers.delete(key);
    if (!buffer.messageId) return;
    await this.callWithRetry("deleteMessage", () =>
      this.bot.telegram.deleteMessage(target.chatId, buffer.messageId),
    ).catch((e) => {
      if (this.logger) {
        this.logger.warn("gateway.channel.stream_cleanup_failed", {
          channel: this.id,
          error: classifyChannelError(e),
        });
      } else {
        process.stderr.write(
          `warning: telegram deleteMessage failed: ${telegramErrorSummary(e)}\n`,
        );
      }
    });
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const me = await this.bot.telegram.getMe();
      return { ok: true, detail: me.username ? `@${me.username}` : String(me.id) };
    } catch (e) {
      return { ok: false, detail: telegramErrorSummary(e) };
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async poll(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = (await this.pollingApi.getUpdates(offset, signal)).sort(
          (left, right) => left.update_id - right.update_id,
        );
        for (const update of updates) {
          if (signal.aborted) return;
          await this.bot.handleUpdate(update);
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        const classified = classifyChannelError(error);
        if (!classified.retryable) throw error;
        await abortableDelay(classified.retryAfterMs ?? 1_000, signal);
      }
    }
  }

  /** Map a Telegram text message into a {@link ChannelMessage}. */
  private normalizeMessage(
    chat: TgChat,
    tgMsg: {
      message_id: number;
      date: number;
      text: string;
      reply_to_message?: { message_id: number; from?: { id: number } };
      message_thread_id?: number;
    },
    from: TgUser,
    updateId: number,
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
      threadId:
        "message_thread_id" in tgMsg && typeof tgMsg.message_thread_id === "number"
          ? String(tgMsg.message_thread_id)
          : undefined,
      metadata: {
        telegramChatType: chat.type,
        telegramMessageId: tgMsg.message_id,
        updateId,
        replyToBot: tgMsg.reply_to_message?.from?.id === this.botUserId,
        mentionedBot: this.botUsername
          ? new RegExp(`(^|\\s)@${escapeRegExp(this.botUsername)}\\b`, "i").test(tgMsg.text)
          : false,
      },
    };
  }

  /**
   * Accumulate a text delta and throttle `editMessageText` by
   * {@link editIntervalMs}. The first delta sends a placeholder message to
   * obtain a message id; subsequent deltas edit it.
   */
  private async handleStreamDelta(target: ChannelSendTarget, delta: string): Promise<void> {
    const key = targetKey(target);
    let buf = this.streamBuffers.get(key);
    if (!buf) {
      buf = { messageId: 0, text: "", lastEdit: 0 };
      this.streamBuffers.set(key, buf);
    }
    buf.text += delta;

    if (!buf.messageId) {
      const sent = await this.sendOrRetry(target, buf.text.slice(0, TELEGRAM_TEXT_LIMIT));
      buf.messageId = sent;
      buf.lastEdit = Date.now();
      return;
    }

    const now = Date.now();
    if (now - buf.lastEdit >= this.editIntervalMs) {
      await this.editOrRetry(target.chatId, buf.messageId, buf.text.slice(0, TELEGRAM_TEXT_LIMIT));
      buf.lastEdit = now;
    }
  }

  /**
   * Send a message, retrying once after a FloodWait delay. Returns the
   * Telegram message id (needed for edit-stream bookkeeping).
   */
  private async sendOrRetry(target: ChannelSendTarget, text: string): Promise<number> {
    const sent = await this.callWithRetry("sendMessage", () =>
      this.bot.telegram.sendMessage(target.chatId, text, telegramThreadExtra(target)),
    );
    return sent.message_id;
  }

  /** Edit a message, retrying once after a FloodWait delay. */
  private async editOrRetry(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.callWithRetry("editMessageText", () =>
        this.bot.telegram.editMessageText(chatId, messageId, undefined, text),
      );
    } catch (e) {
      // "message is not modified" happens when the throttled text equals the
      // last sent text — swallow it to avoid noise.
      if (isMessageNotModified(e)) return;
      // Best-effort: don't let an edit failure crash the turn.
      if (this.logger) {
        this.logger.warn("gateway.channel.stream_edit_failed", {
          channel: this.id,
          error: classifyChannelError(e),
        });
      } else {
        process.stderr.write(
          `warning: telegram editMessageText failed: ${telegramErrorSummary(e)}\n`,
        );
      }
    }
  }

  private async callWithRetry<T>(name: string, call: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await call();
      } catch (e) {
        last = e;
        if (!isTransientTelegramError(e) || attempt === 2) break;
        await delay((readRetryAfter(e) ?? Math.pow(2, attempt)) * 1000);
      }
    }
    if (last instanceof Error) throw last;
    throw new Error(`telegram ${name} failed: ${telegramErrorSummary(last)}`);
  }
}

function targetKey(target: ChannelSendTarget): string {
  return `${target.chatId}:${target.threadId ?? ""}`;
}

function telegramThreadExtra(target: ChannelSendTarget): { message_thread_id?: number } {
  const thread = target.threadId === undefined ? undefined : Number(target.threadId);
  return Number.isSafeInteger(thread) ? { message_thread_id: thread } : {};
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
export function isMessageNotModified(e: unknown): boolean {
  return e instanceof TelegramError && e.description.includes("not modified");
}

export function isTransientTelegramError(e: unknown): boolean {
  const code = (e as { code?: number } | null)?.code;
  const networkCode = (e as { code?: string } | null)?.code;
  return (
    readRetryAfter(e) !== undefined ||
    code === 429 ||
    (typeof code === "number" && code >= 500) ||
    networkCode === "ECONNRESET" ||
    networkCode === "ETIMEDOUT" ||
    networkCode === "EAI_AGAIN"
  );
}

export function telegramErrorSummary(error: unknown): string {
  const code = (error as { code?: string | number } | null)?.code;
  if (code !== undefined) return `API error ${String(code)}`;
  return error instanceof Error && error.name ? error.name : "unknown error";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Split `text` into chunks no longer than `limit` UTF-16 code units.
 *
 * Surrogate pairs are never split: if the boundary lands at a low surrogate
 * (i.e. the preceding code unit is its high surrogate), the chunk is shortened
 * by one so the pair stays intact. This matches the Telegram 4096-UTF-16-unit
 * limit (design.md §4).
 */
export { chunkText };
