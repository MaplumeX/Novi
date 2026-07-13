import { describe, expect, it } from "vitest";
import {
  compactLine,
  simpleDiff,
  toolAction,
  toolResultSummary,
  truncateDetailLines,
} from "./tool-presentation.js";

describe("toolAction", () => {
  it("provides semantic actions for every built-in tool", () => {
    expect(toolAction("read_file", { path: "src/App.tsx" })).toEqual({
      action: "Read",
      target: "src/App.tsx",
    });
    expect(toolAction("grep", { pattern: "TODO", path: "src" })).toEqual({
      action: "Search",
      target: "TODO in src",
    });
    expect(toolAction("web_search", { queries: [{ query: "Ink TUI" }] })).toEqual({
      action: "Search web",
      target: "Ink TUI",
    });
    expect(toolAction("fetch_content", { urls: ["https://a.test", "https://b.test"] })).toEqual({
      action: "Fetch",
      target: "https://a.test +1",
    });
    expect(toolAction("todo", { action: "add", content: "Ship UI" })).toEqual({
      action: "Add todo",
      target: "Ship UI",
    });
  });

  it("humanizes unknown tool names", () => {
    expect(toolAction("custom_agent", {})).toEqual({ action: "Custom agent", target: "" });
  });
});

describe("toolResultSummary", () => {
  it("keeps the first useful error visible", () => {
    expect(
      toolResultSummary({
        name: "bash",
        args: { command: "false" },
        status: "error",
        resultText: "\nboom\nstack",
      }),
    ).toBe("boom");
  });

  it("summarizes file mutations without dumping content", () => {
    expect(
      toolResultSummary({
        name: "edit_file",
        args: { oldText: "one", newText: "one\ntwo" },
        status: "done",
        resultText: "",
      }),
    ).toBe("Updated +1 -0");
    expect(
      toolResultSummary({
        name: "write_file",
        args: { content: "one\ntwo" },
        status: "done",
        resultText: "",
      }),
    ).toBe("Wrote 2 lines");
  });

  it("uses the latest partial line while a command is running", () => {
    expect(
      toolResultSummary({
        name: "bash",
        args: { command: "build" },
        status: "running",
        resultText: "step one\nstep two",
      }),
    ).toBe("step two");
  });
});

describe("detail helpers", () => {
  it("produces a line diff", () => {
    expect(simpleDiff("a\nb", "a\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "delete", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("truncates compact text and long detail output", () => {
    expect(compactLine("a   b", 10)).toBe("a b");
    const lines = Array.from({ length: 22 }, (_, index) => ({
      kind: "normal" as const,
      text: String(index),
    }));
    const truncated = truncateDetailLines(lines);
    expect(truncated).toHaveLength(21);
    expect(truncated.at(-1)?.text).toBe("… 2 more lines");
  });
});
