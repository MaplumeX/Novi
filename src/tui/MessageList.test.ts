import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import { countImages, unmatchedLiveToolCalls } from "./MessageList.js";
import { thinkingPreview } from "./ThinkingBlock.js";
import type { ToolCallView } from "../tools/events.js";

function liveCall(id: string, name: string): ToolCallView {
  return {
    id,
    name,
    tool: {
      name,
      label: name,
      source: { kind: "builtin", id: "native" },
      capabilities: [],
      risk: "read",
    },
    args: {},
    status: "running",
    lastSequence: 0,
    diagnostics: [],
  };
}

describe("countImages", () => {
  it("returns 0 for string content", () => {
    expect(countImages("hello")).toBe(0);
  });

  it("counts image parts", () => {
    expect(countImages([{ type: "text" }, { type: "image" }, { type: "image" }])).toBe(2);
  });

  it("returns 0 when there are no images", () => {
    expect(countImages([{ type: "text" }])).toBe(0);
  });
});

describe("thinkingPreview", () => {
  it("uses the latest meaningful line and compacts whitespace", () => {
    expect(thinkingPreview("first\n\n  latest   thought  ")).toBe("latest thought");
  });
});

describe("unmatchedLiveToolCalls", () => {
  it("filters live calls already represented in assistant history", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "known", name: "bash", arguments: {} }],
      },
    ] as AgentMessage[];
    const live = [liveCall("known", "bash"), liveCall("early", "grep")];

    expect(unmatchedLiveToolCalls(messages, live)).toEqual([live[1]]);
  });
});
