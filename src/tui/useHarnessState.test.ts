import { describe, expect, it } from "vitest";
import {
  normalizeToolArgs,
  normalizeToolResultText,
  projectToolCallEnd,
  projectToolCallStart,
  projectToolCallUpdate,
} from "./useHarnessState.js";

describe("tool-call view projection", () => {
  it("normalizes untyped arguments and text results", () => {
    expect(normalizeToolArgs({ path: "a.ts" })).toEqual({ path: "a.ts" });
    expect(normalizeToolArgs(["bad"])).toEqual({});
    expect(
      normalizeToolResultText({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "..." },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("keeps one stable row from start through update and completion", () => {
    const started = projectToolCallStart([], "call-1", "bash", { command: "pwd" });
    const updated = projectToolCallUpdate(
      started,
      "call-1",
      "bash",
      { command: "pwd" },
      { content: [{ type: "text", text: "/repo" }] },
    );
    const completed = projectToolCallEnd(
      updated,
      "call-1",
      "bash",
      { content: [{ type: "text", text: "exit 0\n/repo" }] },
      false,
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: "call-1",
      args: { command: "pwd" },
      partialText: "/repo",
      resultText: "exit 0\n/repo",
      status: "done",
    });
  });

  it("projects out-of-order update/end events without dropping status", () => {
    const updated = projectToolCallUpdate(
      [],
      "call-2",
      "custom",
      { value: 1 },
      { content: [{ type: "text", text: "partial" }] },
    );
    const failed = projectToolCallEnd(
      updated,
      "call-2",
      "custom",
      { content: [{ type: "text", text: "boom" }] },
      true,
    );

    expect(failed).toEqual([
      {
        id: "call-2",
        name: "custom",
        args: { value: 1 },
        partialText: "partial",
        resultText: "boom",
        status: "error",
      },
    ]);
  });
});
