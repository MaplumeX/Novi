import { describe, expect, it } from "vitest";
import { InboundDeduper, isSilentReply, sessionRoute } from "./routing.js";

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
