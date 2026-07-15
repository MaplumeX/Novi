import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, GatewaySessionLocator } from "../core/types.js";
import { ChannelDeliveryExecutor, deliveryRetryDelayMs } from "./delivery.js";
import { DeliveryRateLimiter, type RateLimitClock } from "./rate-limit.js";

function target(type: "direct" | "group" = "direct"): GatewaySessionLocator {
  return {
    channel: "telegram",
    account: "primary",
    chat: { type, id: "chat" },
  };
}

function fakeClock(): RateLimitClock & { time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.time += ms;
    },
  };
  return clock;
}

function channel(sendFinalChunk: ChannelAdapter["sendFinalChunk"]): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct", "group"] },
    textChunkLimit: 4,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    sendFinalChunk,
  };
}

describe("ChannelDeliveryExecutor", () => {
  it("rate-limits and reports progress after each actual chunk", async () => {
    const clock = fakeClock();
    const calls: Array<{ text: string; ordinal: number; at: number }> = [];
    const adapter = channel(async (_target, text, ordinal) => {
      calls.push({ text, ordinal, at: clock.time });
      return { messageId: String(ordinal + 10) };
    });
    const progress = vi.fn().mockResolvedValue(undefined);
    const executor = new ChannelDeliveryExecutor(new DeliveryRateLimiter({}, clock));

    const result = await executor.execute({
      channel: adapter,
      target: target(),
      text: "abcdefghij",
      onProgress: progress,
    });

    expect(result).toEqual({ ok: true, messageIds: ["10", "11", "12"] });
    expect(calls).toEqual([
      { text: "abcd", ordinal: 0, at: 0 },
      { text: "efgh", ordinal: 1, at: 1_000 },
      { text: "ij", ordinal: 2, at: 2_000 },
    ]);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("returns partial receipts and resumes at the next chunk", async () => {
    const clock = fakeClock();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "10" })
      .mockRejectedValueOnce({ code: "ECONNRESET" });
    const adapter = channel(send);
    const first = await new ChannelDeliveryExecutor(new DeliveryRateLimiter({}, clock)).execute({
      channel: adapter,
      target: target(),
      text: "abcdefgh",
    });
    expect(first).toEqual({
      ok: false,
      messageIds: ["10"],
      error: { code: "NETWORK_ERROR", message: "channel network request failed", retryable: true },
    });

    send.mockResolvedValueOnce({ messageId: "11" });
    const second = await new ChannelDeliveryExecutor(new DeliveryRateLimiter({}, clock)).execute({
      channel: adapter,
      target: target(),
      text: "abcdefgh",
      messageIds: ["10"],
    });
    expect(second).toEqual({ ok: true, messageIds: ["10", "11"] });
    expect(send.mock.calls.at(-1)?.[2]).toBe(1);
  });

  it("freezes future delivery after retry_after", async () => {
    const clock = fakeClock();
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 429, parameters: { retry_after: 2 } })
      .mockResolvedValueOnce({ messageId: "42" });
    const executor = new ChannelDeliveryExecutor(new DeliveryRateLimiter({}, clock));
    const adapter = channel(send);
    const first = await executor.execute({ channel: adapter, target: target(), text: "one" });
    expect(first).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED", retryAfterMs: 2_000 },
    });
    await executor.execute({ channel: adapter, target: target(), text: "two" });
    expect(clock.time).toBe(2_000);
  });
});

describe("deliveryRetryDelayMs", () => {
  it("uses retry_after or bounded jittered exponential backoff", () => {
    expect(deliveryRetryDelayMs(1, 5_000, () => 0)).toBe(5_000);
    expect(deliveryRetryDelayMs(1, 120_000, () => 0)).toBe(120_000);
    expect(deliveryRetryDelayMs(1, undefined, () => 0)).toBe(500);
    expect(deliveryRetryDelayMs(2, undefined, () => 1)).toBe(2_000);
    expect(deliveryRetryDelayMs(100, undefined, () => 1)).toBe(60_000);
  });
});
