import { describe, expect, it } from "vitest";
import { InboundDeduper, isSilentReply, sessionKey } from "./routing.js";

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
    expect(sessionKey("tg-a", message)).toBe("tg-a:group:-1:thread:42");
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
