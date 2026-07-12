import { describe, it, expect } from "vitest";
import { TelegramError } from "telegraf";
import {
  chunkText,
  isMessageNotModified,
  isTransientTelegramError,
  telegramErrorSummary,
} from "./telegram.js";

describe("chunkText", () => {
  it("returns a single empty chunk for empty input", () => {
    expect(chunkText("", 4096)).toEqual([""]);
  });

  it("returns the whole text when under the limit", () => {
    expect(chunkText("hello", 4096)).toEqual(["hello"]);
  });

  it("splits text exceeding the limit at the boundary", () => {
    const text = "a".repeat(10);
    const chunks = chunkText(text, 4);
    expect(chunks).toEqual(["aaaa", "aaaa", "aa"]);
  });

  it("does not split surrogate pairs", () => {
    // "🚀" is a single surrogate pair (2 UTF-16 code units).
    const emoji = "🚀";
    const text = emoji.repeat(3); // 6 UTF-16 units
    const chunks = chunkText(text, 4);
    // Boundary at 4 lands at the start of the 3rd emoji (clean) — the first
    // chunk holds two emojis, the second holds one. No pair is split.
    expect(chunks).toEqual(["🚀🚀", "🚀"]);
  });

  it("backs up when a boundary splits a surrogate pair", () => {
    // 4 emojis = 8 units; limit 5 would split the 3rd emoji's pair.
    const text = "🚀🚀🚀🚀"; // indices 0-1,2-3,4-5,6-7
    const chunks = chunkText(text, 5);
    // end=5 is a low surrogate → back up to 4 → chunk = first two emojis.
    expect(chunks).toEqual(["🚀🚀", "🚀🚀"]);
  });

  it("handles mixed BMP and supplementary text", () => {
    const text = "ab🚀cd🚀ef"; // a,b,surrogate,c,d,surrogate,e,f = 10 units
    const chunks = chunkText(text, 5);
    expect(chunks.join("")).toBe(text);
    // No chunk exceeds the limit.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it("respects the Telegram 4096 limit", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkText(text, 4096);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(4096);
    expect(chunks[2]).toHaveLength(10_000 - 8192);
    expect(chunks.join("")).toBe(text);
  });
});

describe("Telegram retry classification", () => {
  it("retries common transient network failures only", () => {
    expect(isTransientTelegramError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientTelegramError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientTelegramError({ code: 400 })).toBe(false);
  });
  it("recognizes not-modified and redacts diagnostic detail", () => {
    expect(
      isMessageNotModified(
        new TelegramError({ error_code: 400, description: "Bad Request: message is not modified" }),
      ),
    ).toBe(true);
    expect(
      telegramErrorSummary(
        Object.assign(new Error("https://api.telegram.org/botSECRET"), { code: "ECONNRESET" }),
      ),
    ).toBe("API error ECONNRESET");
  });
});
