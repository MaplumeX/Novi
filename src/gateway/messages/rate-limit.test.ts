import { describe, expect, it } from "vitest";
import type { GatewaySessionLocator } from "../core/types.js";
import { DeliveryRateLimiter, type RateLimitClock } from "./rate-limit.js";

function target(chatId: string, type: "direct" | "group" = "direct"): GatewaySessionLocator {
  return {
    channel: "telegram",
    account: "primary",
    chat: { type, id: chatId },
  };
}

function fakeClock(): RateLimitClock & { time: number; sleeps: number[] } {
  const clock = {
    time: 0,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

describe("DeliveryRateLimiter", () => {
  it("enforces account and direct-chat intervals without real waiting", async () => {
    const clock = fakeClock();
    const limiter = new DeliveryRateLimiter({}, clock);
    await limiter.acquire(target("one"));
    await limiter.acquire(target("two"));
    await limiter.acquire(target("two"));

    expect(clock.sleeps).toEqual([40, 1_000]);
    expect(clock.time).toBe(1_040);
  });

  it("enforces the 20 messages/minute group rate", async () => {
    const clock = fakeClock();
    const limiter = new DeliveryRateLimiter({}, clock);
    await limiter.acquire(target("group", "group"));
    await limiter.acquire(target("group", "group"));
    expect(clock.sleeps).toEqual([3_000]);
  });

  it("freezes both scopes for retry_after and rejects looser configuration", async () => {
    const clock = fakeClock();
    const limiter = new DeliveryRateLimiter({}, clock);
    await limiter.acquire(target("one"));
    limiter.freeze(target("one"), 2_000);
    await limiter.acquire(target("one"));
    expect(clock.sleeps).toEqual([2_000]);

    expect(() => new DeliveryRateLimiter({ accountPerSecond: 26 })).toThrow(/tighten/);
    expect(() => new DeliveryRateLimiter({ directPerSecond: 2 })).toThrow(/tighten/);
    expect(() => new DeliveryRateLimiter({ groupPerMinute: 21 })).toThrow(/tighten/);
  });
});
