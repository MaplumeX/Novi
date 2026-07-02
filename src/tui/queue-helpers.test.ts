import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { messageText, restoreText } from "./queue-helpers.js";

const text = (t: string): TextContent => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking" as const, thinking: t });
const image = (): ImageContent => ({ type: "image", data: "x", mimeType: "image/png" });

describe("messageText", () => {
  it("extracts a plain string user message", () => {
    const msg: AgentMessage = { role: "user", content: "hello", timestamp: 0 };
    expect(messageText(msg)).toBe("hello");
  });

  it("joins text parts of a content-array user message", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [text("a"), image(), text("b")],
      timestamp: 0,
    };
    expect(messageText(msg)).toBe("a b");
  });

  it("returns empty for an assistant message with no text parts", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [thinking("hidden")],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    expect(messageText(msg)).toBe("");
  });

  it("extracts the command from a bashExecution message", () => {
    const msg: AgentMessage = {
      role: "bashExecution",
      command: "ls -la",
      output: "",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    };
    expect(messageText(msg)).toBe("ls -la");
  });

  it("extracts summary from branch/compaction summary messages", () => {
    expect(
      messageText({ role: "branchSummary", summary: "branched", fromId: "1", timestamp: 0 }),
    ).toBe("branched");
    expect(
      messageText({ role: "compactionSummary", summary: "compacted", tokensBefore: 10, timestamp: 0 }),
    ).toBe("compacted");
  });

  it("extracts a custom message with string content", () => {
    const msg: AgentMessage = {
      role: "custom",
      customType: "note",
      content: "a note",
      display: true,
      timestamp: 0,
    };
    expect(messageText(msg)).toBe("a note");
  });
});

describe("restoreText", () => {
  it("returns current text when nothing to restore", () => {
    expect(restoreText([], "draft")).toBe("draft");
  });

  it("returns restored text when editor is empty", () => {
    expect(restoreText(["queued"], "")).toBe("queued");
  });

  it("joins multiple queued texts with newlines", () => {
    expect(restoreText(["a", "b"], "")).toBe("a\nb");
  });

  it("appends current text after restored, newline-separated", () => {
    expect(restoreText(["queued"], "draft")).toBe("queued\ndraft");
  });

  it("skips empty queued texts", () => {
    expect(restoreText(["a", "", "b"], "draft")).toBe("a\nb\ndraft");
  });

  it("returns current text when all queued texts are empty", () => {
    expect(restoreText(["", ""], "draft")).toBe("draft");
  });
});
