import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Update as TgUpdate } from "@telegraf/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TelegramChannel,
  type TelegramPollingApi,
} from "./telegram.js";
import type { MediaDownloader, DownloadResult } from "./telegram-media.js";
import type { ChannelMessage } from "../core/types.js";

// Mock getNoviDir so saveAttachmentFile writes to a temp dir.
let tmpNoviDir = "";
vi.mock("../../config.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getNoviDir: () => tmpNoviDir };
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "novi-tg-media-"));
  tmpNoviDir = tmpDir;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makePollingApi(updates: TgUpdate[]): TelegramPollingApi {
  return {
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
      if (offset >= updates.length) {
        return new Promise<TgUpdate[]>((resolve) => {
          signal.addEventListener("abort", () => resolve([]), { once: true });
        });
      }
      return updates.filter((u) => u.update_id >= offset);
    },
  };
}

/** Create a mock downloader that returns fake bytes for any file_id. */
function makeMockDownloader(
  bytes: Buffer = Buffer.from("fake-content"),
  mimeType = "image/jpeg",
  filename = "file.jpg",
): MediaDownloader {
  return {
    download: vi.fn().mockImplementation(
      async (): Promise<DownloadResult> => ({
        bytes,
        mimeType,
        filename,
        size: bytes.byteLength,
      }),
    ),
  };
}

/** Build a Telegram photo update. */
function photoUpdate(
  updateId: number,
  caption?: string,
): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 7, is_bot: false, first_name: "User" },
      photo: [
        { file_id: "small", file_unique_id: "uid-s", width: 100, height: 100, file_size: 500 },
        { file_id: "large", file_unique_id: "uid-l", width: 800, height: 600, file_size: 5000 },
      ],
      ...(caption !== undefined ? { caption } : {}),
    },
  } as TgUpdate;
}

/** Build a Telegram document update. */
function documentUpdate(
  updateId: number,
  filename: string,
  mimeType: string,
  caption?: string,
): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 7, is_bot: false, first_name: "User" },
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-uid",
        file_name: filename,
        mime_type: mimeType,
        file_size: 12345,
      },
      ...(caption !== undefined ? { caption } : {}),
    },
  } as TgUpdate;
}

/** Build a Telegram voice update. */
function voiceUpdate(updateId: number, caption?: string): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 7, is_bot: false, first_name: "User" },
      voice: {
        file_id: "voice-file-id",
        file_unique_id: "voice-uid",
        duration: 5,
        mime_type: "audio/ogg",
        file_size: 8000,
      },
      ...(caption !== undefined ? { caption } : {}),
    },
  } as TgUpdate;
}

/** Build a Telegram animation update (goes through document handler). */
function animationUpdate(updateId: number): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 7, is_bot: false, first_name: "User" },
      document: {
        file_id: "anim-file-id",
        file_unique_id: "anim-uid",
        file_name: "animation.mp4",
        mime_type: "video/mp4",
        file_size: 50000,
      },
      animation: {
        file_id: "anim-file-id",
        file_unique_id: "anim-uid",
        width: 400,
        height: 300,
        duration: 3,
        mime_type: "video/mp4",
        file_size: 50000,
      },
    },
  } as TgUpdate;
}

async function captureMessages(
  channel: TelegramChannel,
  updates: TgUpdate[],
): Promise<ChannelMessage[]> {
  const messages: ChannelMessage[] = [];
  channel.onMessage = async (msg) => {
    messages.push(msg);
  };
  await channel.start();
  // Wait for all updates to be processed.
  await vi.waitFor(() => expect(messages.length).toBe(updates.length), { timeout: 2000 });
  await channel.stop();
  return messages;
}

describe("Telegram media: photo", () => {
  it("normalizes photo message with caption into attachments + images", async () => {
    const updates = [photoUpdate(10, "check this out")];
    const downloader = makeMockDownloader(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic bytes
      "image/jpeg",
      "photo.jpg",
    );
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.text).toBe("check this out");
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments![0].kind).toBe("image");
    expect(msg.attachments![0].mimeType).toBe("image/jpeg");
    expect(msg.attachments![0].size).toBe(5000); // largest photo size
    expect(msg.attachments![0].remoteFileId).toBe("large");
    expect(msg.images).toBeDefined();
    expect(msg.images!.length).toBe(1);
    expect(msg.images![0].type).toBe("image");
    expect(msg.images![0].mimeType).toBe("image/jpeg");
    // Images are base64 — no localPath for images.
    expect(msg.attachments![0].localPath).toBeUndefined();
  });

  it("uses empty text when photo has no caption", async () => {
    const updates = [photoUpdate(10)];
    const downloader = makeMockDownloader();
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages[0].text).toBe("");
  });
});

describe("Telegram media: document", () => {
  it("normalizes document message with caption into attachments + localPath", async () => {
    const updates = [documentUpdate(10, "report.pdf", "application/pdf", "see this report")];
    const downloader = makeMockDownloader(
      Buffer.from("fake-pdf-content"),
      "application/pdf",
      "report.pdf",
    );
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.text).toBe("see this report");
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments![0].kind).toBe("file");
    expect(msg.attachments![0].mimeType).toBe("application/pdf");
    expect(msg.attachments![0].size).toBe(12345);
    expect(msg.attachments![0].filename).toBe("report.pdf");
    expect(msg.attachments![0].remoteFileId).toBe("doc-file-id");
    expect(msg.attachments![0].localPath).toBeDefined();
    expect(msg.attachments![0].localPath!.startsWith("gateway-media/")).toBe(true);
    // No images for file attachments.
    expect(msg.images).toBeUndefined();
  });

  it("uses empty text when document has no caption", async () => {
    const updates = [documentUpdate(10, "data.csv", "text/csv")];
    const downloader = makeMockDownloader(Buffer.from("a,b,c"), "text/csv", "data.csv");
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);
    expect(messages[0].text).toBe("");
  });
});

describe("Telegram media: voice", () => {
  it("normalizes voice message into attachments + localPath", async () => {
    const updates = [voiceUpdate(10, "voice note")];
    const downloader = makeMockDownloader(
      Buffer.from("fake-ogg"),
      "audio/ogg",
      "voice.ogg",
    );
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.text).toBe("voice note");
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments![0].kind).toBe("voice");
    expect(msg.attachments![0].mimeType).toBe("audio/ogg");
    expect(msg.attachments![0].size).toBe(8000);
    expect(msg.attachments![0].remoteFileId).toBe("voice-file-id");
    expect(msg.attachments![0].localPath).toBeDefined();
    expect(msg.attachments![0].localPath!.startsWith("gateway-media/")).toBe(true);
    expect(msg.images).toBeUndefined();
  });
});

describe("Telegram media: unsupported types", () => {
  it("diagnoses animation as unsupported without filling attachments", async () => {
    const updates = [animationUpdate(10)];
    const downloader = makeMockDownloader();
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.text).toContain("[unsupported media type: animation]");
    expect(msg.attachments).toBeUndefined();
    expect(msg.images).toBeUndefined();
    expect(msg.metadata?.unsupported).toBe("animation");
    // Downloader should not have been called for unsupported types.
    expect(downloader.download).not.toHaveBeenCalled();
  });
});

describe("Telegram media: download failure", () => {
  it("degrades gracefully when image download fails", async () => {
    const updates = [photoUpdate(10, "look at this")];
    const downloader: MediaDownloader = {
      download: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    // Caption is preserved + error note appended.
    expect(msg.text).toContain("look at this");
    expect(msg.text).toContain("image download failed");
    expect(msg.metadata?.downloadFailed).toBe(true);
    // No images or attachments on failure.
    expect(msg.images).toBeUndefined();
    expect(msg.attachments).toBeUndefined();
  });

  it("degrades gracefully when file download fails", async () => {
    const updates = [documentUpdate(10, "report.pdf", "application/pdf", "read this")];
    const downloader: MediaDownloader = {
      download: vi.fn().mockRejectedValue(new Error("403 forbidden")),
    };
    const channel = new TelegramChannel({
      id: "primary",
      botToken: "test",
      pollingApi: makePollingApi(updates),
      mediaDownloader: downloader,
    });
    const messages = await captureMessages(channel, updates);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.text).toContain("read this");
    expect(msg.text).toContain("file download failed");
    expect(msg.metadata?.downloadFailed).toBe(true);
  });
});