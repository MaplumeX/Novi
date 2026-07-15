import { describe, it, expect, vi } from "vitest";
import { TelegramError } from "telegraf";
import type { Update as TgUpdate } from "@telegraf/types";
import {
  chunkText,
  isMessageNotModified,
  isTransientTelegramError,
  telegramErrorSummary,
  TelegramChannel,
  type TelegramPollingApi,
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

describe("Telegram owned polling", () => {
  it("does not advance past a failed durable callback or process higher updates", async () => {
    const offsets: number[] = [];
    const updates = [telegramUpdate(10), telegramUpdate(11), telegramUpdate(12)];
    const api: TelegramPollingApi = {
      getMe: async () => ({
        id: 99,
        is_bot: true,
        first_name: "Novi",
        username: "novi_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      }),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getUpdates: async (offset, signal) => {
        offsets.push(offset);
        if (offset < 13) return updates.filter((update) => update.update_id >= offset);
        return new Promise<TgUpdate[]>((resolve) => {
          signal.addEventListener("abort", () => resolve([]), { once: true });
        });
      },
    };
    const channel = new TelegramChannel({ id: "primary", botToken: "test", pollingApi: api });
    const seen: number[] = [];
    let failOnce = true;
    channel.onMessage = async (message) => {
      const updateId = Number(message.metadata?.updateId);
      seen.push(updateId);
      if (updateId === 11 && failOnce) {
        failOnce = false;
        throw { code: 429, parameters: { retry_after: 0 } };
      }
    };

    await channel.start();
    await vi.waitFor(() => expect(offsets).toContain(13));
    await channel.stop();

    expect(offsets.slice(0, 3)).toEqual([0, 11, 13]);
    expect(seen).toEqual([10, 11, 11, 12]);
    expect(seen.indexOf(12)).toBeGreaterThan(seen.lastIndexOf(11));
  });
});

function telegramUpdate(updateId: number): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 7, is_bot: false, first_name: "User" },
      text: `message-${updateId}`,
    },
  };
}

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
