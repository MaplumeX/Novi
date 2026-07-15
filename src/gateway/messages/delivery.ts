import { chunkText } from "../core/text.js";
import type { ChannelAdapter, GatewaySessionLocator } from "../core/types.js";
import { channelTargetForLocator } from "../core/routing.js";
import { classifyChannelError } from "./errors.js";
import { DeliveryRateLimiter } from "./rate-limit.js";
import type { MessageError } from "./types.js";

export interface DeliveryProgress {
  ordinal: number;
  messageId: string;
}

export type DeliveryAttemptResult =
  { ok: true; messageIds: string[] } | { ok: false; messageIds: string[]; error: MessageError };

export interface DeliveryAttemptInput {
  channel: ChannelAdapter;
  target: GatewaySessionLocator;
  text: string;
  messageIds?: string[];
  onProgress?: (progress: DeliveryProgress) => Promise<void>;
}

/** Executes one bounded delivery attempt; retry scheduling remains a store concern. */
export class ChannelDeliveryExecutor {
  constructor(private readonly rateLimiter = new DeliveryRateLimiter()) {}

  async execute(input: DeliveryAttemptInput): Promise<DeliveryAttemptResult> {
    const target = channelTargetForLocator(input.target);
    const messageIds = [...(input.messageIds ?? [])];
    if (!input.channel.sendFinalChunk) {
      if (messageIds.length > 0) {
        return {
          ok: false,
          messageIds,
          error: {
            code: "PARTIAL_RESUME_UNSUPPORTED",
            message: "channel cannot resume partial delivery",
            retryable: false,
          },
        };
      }
      await this.rateLimiter.acquire(input.target);
      try {
        const receipt = await input.channel.send(target, input.text);
        return { ok: true, messageIds: [...receipt.messageIds] };
      } catch (error) {
        return this.failure(input.target, messageIds, error);
      }
    }

    const chunks = chunkText(input.text, input.channel.textChunkLimit);
    if (messageIds.length > chunks.length) {
      throw new Error("delivery receipt cursor exceeds final chunk count");
    }
    for (let ordinal = messageIds.length; ordinal < chunks.length; ordinal++) {
      await this.rateLimiter.acquire(input.target);
      try {
        const receipt = await input.channel.sendFinalChunk(target, chunks[ordinal]!, ordinal);
        messageIds.push(receipt.messageId);
        await input.onProgress?.({ ordinal, messageId: receipt.messageId });
      } catch (error) {
        return this.failure(input.target, messageIds, error);
      }
    }
    return { ok: true, messageIds };
  }

  private failure(
    target: GatewaySessionLocator,
    messageIds: string[],
    failure: unknown,
  ): DeliveryAttemptResult {
    const error = classifyChannelError(failure);
    if (error.retryAfterMs !== undefined) this.rateLimiter.freeze(target, error.retryAfterMs);
    return { ok: false, messageIds: [...messageIds], error };
  }
}

/** Jittered exponential delay after a completed attempt, capped at one minute. */
export function deliveryRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
  const exponential = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(exponential * (0.5 + sample * 0.5));
}
