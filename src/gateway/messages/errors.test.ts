import { describe, expect, it } from "vitest";
import { TelegramError } from "telegraf";
import { classifyChannelError, redactAndBoundError } from "./errors.js";

describe("classifyChannelError", () => {
  it("classifies retryable rate, remote and network failures", () => {
    expect(
      classifyChannelError(
        new TelegramError({
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 3 },
        }),
      ),
    ).toEqual({
      code: "RATE_LIMITED",
      message: "channel rate limit exceeded",
      retryable: true,
      retryAfterMs: 3_000,
    });
    expect(classifyChannelError({ code: 503 })).toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true,
    });
    expect(classifyChannelError({ code: "ECONNRESET" })).toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });

  it("classifies authentication and invalid targets as permanent", () => {
    expect(classifyChannelError({ code: 401 })).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(classifyChannelError({ code: 403 })).toMatchObject({
      code: "CHANNEL_FORBIDDEN",
      retryable: false,
    });
    expect(classifyChannelError({ code: 400, description: "Bad Request: chat not found" })).toEqual(
      {
        code: "INVALID_TARGET",
        message: "delivery target is invalid",
        retryable: false,
      },
    );
  });

  it("never persists raw Telegram URLs or credential-shaped details", () => {
    const bounded = redactAndBoundError(
      new Error(
        `https://api.telegram.org/bot123:secret/sendMessage Authorization: Bearer abc token=xyz ${"x".repeat(600)}`,
      ),
    );
    expect(bounded).not.toContain("123:secret");
    expect(bounded).not.toContain("abc");
    expect(bounded).not.toContain("xyz");
    expect(bounded.length).toBeLessThanOrEqual(500);
  });
});
