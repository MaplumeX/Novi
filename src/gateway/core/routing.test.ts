import { describe, expect, it } from "vitest";
import {
  InboundDeduper,
  channelTargetForLocator,
  channelTargetForMessage,
  isSilentReply,
  sessionRoute,
} from "./routing.js";

describe("gateway routing helpers", () => {
  it("isolates topic sessions by channel, chat kind and topic", () => {
    const message = {
      id: "1",
      remoteChatId: "-1",
      chatType: "group" as const,
      senderId: "u",
      text: "hi",
      timestamp: new Date(),
      threadId: "42",
    };
    expect(sessionRoute({ id: "tg-a", type: "telegram" }, message)).toEqual({
      key: "gateway:telegram:tg-a:group:-1:thread:42",
      locator: {
        channel: "telegram",
        account: "tg-a",
        chat: { type: "group", id: "-1" },
        thread: "42",
      },
    });
  });
  it("encodes delimiter characters without collisions", () => {
    const base = {
      id: "1",
      remoteChatId: "chat:one",
      chatType: "direct" as const,
      senderId: "u",
      text: "hi",
      timestamp: new Date(),
    };
    expect(sessionRoute({ id: "account:one", type: "telegram" }, base).key).toBe(
      "gateway:telegram:account%3Aone:direct:chat%3Aone",
    );
  });
  it("recognizes explicit silent markers only", () => {
    expect(isSilentReply(" [SILENT] ")).toBe(true);
    expect(isSilentReply("no reply")).toBe(true);
    expect(isSilentReply("silently explain")).toBe(false);
  });
  it("deduplicates only inside its TTL", () => {
    const deduper = new InboundDeduper(10);
    expect(deduper.seenBefore("a", 0)).toBe(false);
    expect(deduper.seenBefore("a", 1)).toBe(true);
    expect(deduper.seenBefore("a", 11)).toBe(false);
  });
});

describe("channelTargetForLocator", () => {
  it("passes replyTo through to replyToMessageId", () => {
    const locator = {
      channel: "telegram" as const,
      account: "primary",
      chat: { type: "direct" as const, id: "123" },
      replyTo: "msg-42",
    };
    expect(channelTargetForLocator(locator)).toEqual({
      chatId: "123",
      replyToMessageId: "msg-42",
    });
  });

  it("omits replyToMessageId when locator has no replyTo", () => {
    const locator = {
      channel: "telegram" as const,
      account: "primary",
      chat: { type: "direct" as const, id: "123" },
      thread: "topic-1",
    };
    expect(channelTargetForLocator(locator)).toEqual({
      chatId: "123",
      threadId: "topic-1",
    });
  });
});

describe("channelTargetForMessage", () => {
  it("passes replyToMessageId from inbound message", () => {
    const message = {
      id: "m1",
      remoteChatId: "123",
      chatType: "direct" as const,
      senderId: "u",
      text: "hi",
      timestamp: new Date(),
      replyToMessageId: "msg-99",
    };
    expect(channelTargetForMessage(message)).toEqual({
      chatId: "123",
      replyToMessageId: "msg-99",
    });
  });

  it("omits replyToMessageId when message has none", () => {
    const message = {
      id: "m1",
      remoteChatId: "123",
      chatType: "direct" as const,
      senderId: "u",
      text: "hi",
      timestamp: new Date(),
    };
    expect(channelTargetForMessage(message)).toEqual({ chatId: "123" });
  });
});
